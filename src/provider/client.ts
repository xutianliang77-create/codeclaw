import type { EngineMessage } from "../agent/types";
import type { ProviderStatus } from "./types";
import { readFile } from "node:fs/promises";

type FetchLike = typeof fetch;

/**
 * Provider 真实 token 用量（W3-05）。三家提供商语义略有差异，统一抽象：
 *   - inputTokens：prompt / input
 *   - outputTokens：completion / output
 *   - modelId：实际响应里看到的模型 id（可能与 request 不同，比如 anthropic 路由）
 *   - costUsd：可选；若 caller 知道 provider 价位可在外面算
 */
export interface ProviderUsage {
  provider: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly responseBody?: string
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

function joinUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
}

function getConnectTimeoutMs(provider: ProviderStatus): number {
  return provider.kind === "local" ? Math.max(provider.timeoutMs, 30_000) : provider.timeoutMs;
}

async function toOpenAiMessages(messages: EngineMessage[]): Promise<Array<{ role: string; content: string | Array<Record<string, unknown>> }>> {
  return Promise.all(
    messages
      .filter((message) => message.role !== "system")
      .map(async (message) => ({
        role: message.role,
        content: await toOpenAiContent(message)
      }))
  );
}

async function toAnthropicMessages(messages: EngineMessage[]): Promise<Array<{ role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }>> {
  return Promise.all(
    messages
      .filter((message) => message.role !== "system")
      .map(async (message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: await toAnthropicContent(message)
      }))
  );
}

function toOllamaMessages(messages: EngineMessage[]): Array<{ role: string; content: string }> {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: message.text
    }));
}

async function toOpenAiContent(message: EngineMessage): Promise<string | Array<Record<string, unknown>>> {
  if (!message.attachments?.length) {
    return message.text;
  }

  const imageParts = await Promise.all(
    message.attachments.map(async (attachment) => ({
      type: "image_url",
      image_url: {
        url: await toImageDataUrl(attachment.localPath, attachment.mimeType)
      }
    }))
  );

  return [
    {
      type: "text",
      text: message.text
    },
    ...imageParts
  ];
}

async function toAnthropicContent(message: EngineMessage): Promise<string | Array<Record<string, unknown>>> {
  if (!message.attachments?.length) {
    return message.text;
  }

  const imageParts = await Promise.all(
    message.attachments.map(async (attachment) => {
      const dataUrl = await toImageDataUrl(attachment.localPath, attachment.mimeType);
      const [mediaType, base64] = parseDataUrl(dataUrl);
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: base64
        }
      };
    })
  );

  return [
    {
      type: "text",
      text: message.text
    },
    ...imageParts
  ];
}

async function toImageDataUrl(localPath: string, mimeType = "image/jpeg"): Promise<string> {
  const buffer = await readFile(localPath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function parseDataUrl(dataUrl: string): [string, string] {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) {
    throw new Error("Unsupported image data URL");
  }

  return [match[1], match[2]];
}

async function fetchWithConnectTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  }, timeoutMs);

  const forwardAbort = () => {
    controller.abort(abortSignal?.reason);
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort(abortSignal.reason);
    } else {
      abortSignal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
    abortSignal?.removeEventListener("abort", forwardAbort);
  }
}

function getDeltaTextFromOpenAiPayload(payload: unknown): string {
  const choice = (payload as { choices?: Array<{ delta?: { content?: unknown } }> }).choices?.[0];
  const content = choice?.delta?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }

  return "";
}

async function* streamSseLines(
  response: Response,
  onData: (payload: string) => string
): AsyncGenerator<string> {
  if (!response.body) {
    throw new Error("Provider response body is empty");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) {
        continue;
      }

      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }

      const delta = onData(payload);
      if (delta) {
        yield delta;
      }
    }
  }

  const finalChunk = decoder.decode();
  if (finalChunk) {
    buffer += finalChunk;
  }

  if (buffer.startsWith("data:")) {
    const payload = buffer.slice(5).trim();
    if (payload && payload !== "[DONE]") {
      const delta = onData(payload);
      if (delta) {
        yield delta;
      }
    }
  }
}

async function* streamNdjson(
  response: Response,
  onLine: (payload: string) => string
): AsyncGenerator<string> {
  if (!response.body) {
    throw new Error("Provider response body is empty");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const delta = onLine(trimmed);
      if (delta) {
        yield delta;
      }
    }
  }

  const finalChunk = decoder.decode();
  if (finalChunk) {
    buffer += finalChunk;
  }

  const trimmed = buffer.trim();
  if (trimmed) {
    const delta = onLine(trimmed);
    if (delta) {
      yield delta;
    }
  }
}

async function* streamOpenAiCompatible(
  provider: ProviderStatus,
  messages: EngineMessage[],
  fetchImpl: FetchLike,
  abortSignal?: AbortSignal,
  onUsage?: (usage: ProviderUsage) => void
): AsyncGenerator<string> {
  const response = await fetchWithConnectTimeout(
    fetchImpl,
    joinUrl(provider.baseUrl, "/chat/completions"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: provider.model,
        stream: true,
        // W3-05：要求 OpenAI 在最后一帧返回 usage（默认 stream 不返回）
        stream_options: { include_usage: true },
        // 给 output 设宽松上限：4096 token 对绝大部分中长答案足够（~12k 字符），
        // 又能挡极端无限输出。本地模型 ctx ≥ 8k 时 prompt+4096 都能塞下；
        // ctx < 8k 时 caller 应在 provider.config 覆盖（W4 落）。
        max_tokens: 4096,
        messages: await toOpenAiMessages(messages)
      })
    },
    getConnectTimeoutMs(provider),
    abortSignal
  );

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw new ProviderRequestError(
      `Provider request failed (${response.status} ${response.statusText})`,
      response.status,
      responseBody
    );
  }

  yield* streamSseLines(response, (payload) => {
    const parsed = JSON.parse(payload) as unknown;
    // W3-05：最后一帧通常带 usage（OpenAI 协议）
    if (onUsage && parsed && typeof parsed === "object") {
      const obj = parsed as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; model?: string };
      if (obj.usage) {
        onUsage({
          provider: provider.type,
          modelId: obj.model ?? provider.model,
          inputTokens: obj.usage.prompt_tokens,
          outputTokens: obj.usage.completion_tokens,
          totalTokens: obj.usage.total_tokens,
        });
      }
    }
    return getDeltaTextFromOpenAiPayload(parsed);
  });
}

async function* streamAnthropic(
  provider: ProviderStatus,
  messages: EngineMessage[],
  fetchImpl: FetchLike,
  abortSignal?: AbortSignal,
  onUsage?: (usage: ProviderUsage) => void
): AsyncGenerator<string> {
  const response = await fetchWithConnectTimeout(
    fetchImpl,
    joinUrl(provider.baseUrl, "/v1/messages"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(provider.apiKey ? { "x-api-key": provider.apiKey } : {})
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 1024,
        stream: true,
        messages: await toAnthropicMessages(messages)
      })
    },
    getConnectTimeoutMs(provider),
    abortSignal
  );

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw new ProviderRequestError(
      `Provider request failed (${response.status} ${response.statusText})`,
      response.status,
      responseBody
    );
  }

  // W3-05：Anthropic 用 message_start (input_tokens) + message_delta (output_tokens) 累加
  let anthropicInput = 0;
  let anthropicOutput = 0;
  let anthropicModel: string | undefined;
  yield* streamSseLines(response, (payload) => {
    const parsed = JSON.parse(payload) as {
      type?: string;
      delta?: { text?: string };
      message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (onUsage && parsed.type === "message_start") {
      anthropicInput = parsed.message?.usage?.input_tokens ?? 0;
      anthropicModel = parsed.message?.model;
    }
    if (onUsage && parsed.type === "message_delta" && parsed.usage) {
      anthropicOutput = parsed.usage.output_tokens ?? anthropicOutput;
    }
    if (onUsage && parsed.type === "message_stop") {
      onUsage({
        provider: provider.type,
        modelId: anthropicModel ?? provider.model,
        inputTokens: anthropicInput,
        outputTokens: anthropicOutput,
        totalTokens: anthropicInput + anthropicOutput,
      });
    }
    return parsed.type === "content_block_delta" ? parsed.delta?.text ?? "" : "";
  });
}

async function* streamOllama(
  provider: ProviderStatus,
  messages: EngineMessage[],
  fetchImpl: FetchLike,
  abortSignal?: AbortSignal,
  onUsage?: (usage: ProviderUsage) => void
): AsyncGenerator<string> {
  const response = await fetchWithConnectTimeout(
    fetchImpl,
    joinUrl(provider.baseUrl, "/api/chat"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: provider.model,
        stream: true,
        messages: toOllamaMessages(messages)
      })
    },
    getConnectTimeoutMs(provider),
    abortSignal
  );

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw new ProviderRequestError(
      `Provider request failed (${response.status} ${response.statusText})`,
      response.status,
      responseBody
    );
  }

  yield* streamNdjson(response, (payload) => {
    const parsed = JSON.parse(payload) as {
      message?: { content?: string };
      done?: boolean;
      prompt_eval_count?: number;
      eval_count?: number;
      model?: string;
    };
    // W3-05：Ollama 在最后一行 done=true 时附 prompt_eval_count / eval_count
    if (onUsage && parsed.done === true) {
      onUsage({
        provider: provider.type,
        modelId: parsed.model ?? provider.model,
        inputTokens: parsed.prompt_eval_count,
        outputTokens: parsed.eval_count,
        totalTokens:
          (parsed.prompt_eval_count ?? 0) + (parsed.eval_count ?? 0) || undefined,
      });
    }
    return parsed.message?.content ?? "";
  });
}

export async function* streamProviderResponse(
  provider: ProviderStatus,
  messages: EngineMessage[],
  options?: {
    fetchImpl?: FetchLike;
    abortSignal?: AbortSignal;
    /** W3-05：每流末尾收到 provider 的 token usage 时回调（best-effort，可选） */
    onUsage?: (usage: ProviderUsage) => void;
  }
): AsyncGenerator<string> {
  const fetchImpl = options?.fetchImpl ?? fetch;

  if (provider.type === "anthropic") {
    yield* streamAnthropic(provider, messages, fetchImpl, options?.abortSignal, options?.onUsage);
    return;
  }

  if (provider.type === "ollama") {
    yield* streamOllama(provider, messages, fetchImpl, options?.abortSignal, options?.onUsage);
    return;
  }

  yield* streamOpenAiCompatible(provider, messages, fetchImpl, options?.abortSignal, options?.onUsage);
}
