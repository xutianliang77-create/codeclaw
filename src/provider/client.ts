import type { EngineMessage } from "../agent/types";
import type { ProviderStatus } from "./types";
import type { ToolCallEvent, ToolInputSchema } from "../agent/tools/registry";
import { readFile } from "node:fs/promises";

/** 给 streamProviderResponse 用的 tools spec（OpenAI / Anthropic 形态见 registry.openAiSchemas/anthropicSchemas） */
export interface ToolSchemaSpec {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

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

async function toOpenAiMessages(messages: EngineMessage[]): Promise<Array<Record<string, unknown>>> {
  // M1-A：保留 system role；OpenAI 兼容协议本就接受 system messages
  // M1-B/C：role:"tool" → {role:"tool", tool_call_id, content}；assistant + toolCalls → tool_calls 数组
  return Promise.all(
    messages.map(async (message) => {
      if (message.role === "tool") {
        return {
          role: "tool",
          tool_call_id: message.toolCallId ?? "",
          content: message.text,
        };
      }
      if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: message.text || null,
          tool_calls: message.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          })),
        };
      }
      return {
        role: message.role,
        content: await toOpenAiContent(message),
      };
    })
  );
}

async function toAnthropicMessages(messages: EngineMessage[]): Promise<Array<{ role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }>> {
  // Anthropic 的 system 不在 messages 数组里，是 top-level system 字段；调用方先 extractAnthropicSystem
  // M1-B/C：tool 结果是 user role 内嵌 tool_result block；连续 tool 消息合并到一条 user.content
  // assistant + toolCalls 转 assistant.content [{type:text}, {type:tool_use,id,name,input}]
  const out: Array<{ role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }> = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];

  const flushPending = () => {
    if (pendingToolResults.length > 0) {
      out.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: m.toolCallId ?? "",
        content: m.text,
      });
      continue;
    }
    flushPending();
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const c of m.toolCalls) {
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({
        role: m.role === "assistant" ? "assistant" : "user",
        content: await toAnthropicContent(m),
      });
    }
  }
  flushPending();
  return out;
}

function extractAnthropicSystem(messages: EngineMessage[]): string | undefined {
  const sys = messages
    .filter((m) => m.role === "system")
    .map((m) => m.text)
    .filter((t) => t.trim().length > 0);
  return sys.length > 0 ? sys.join("\n\n") : undefined;
}

function toOllamaMessages(messages: EngineMessage[]): Array<{ role: string; content: string }> {
  // M1-A：Ollama /api/chat 支持 system role；同样保留
  return messages.map((message) => ({
    role: message.role,
    content: message.text
  }));
}

async function toOpenAiContent(message: EngineMessage): Promise<string | Array<Record<string, unknown>>> {
  if (!message.attachments?.length) {
    return message.text;
  }

  // M2-05：image 走 data URL；file 走 extractAttachmentText 拼成 text block
  const { extractAttachmentText } = await import("../agent/attachments/extract");
  const path = await import("node:path");

  const parts = await Promise.all(
    message.attachments.map(async (attachment) => {
      if (attachment.kind === "image") {
        return {
          type: "image_url",
          image_url: {
            url: await toImageDataUrl(attachment.localPath, attachment.mimeType),
          },
        };
      }
      // file kind
      const extracted = await extractAttachmentText(attachment.localPath);
      const fileName = attachment.fileName ?? path.basename(attachment.localPath);
      return {
        type: "text",
        text: `\n--- Attachment: ${fileName} ---\n${extracted}\n--- End ---\n`,
      };
    })
  );

  return [
    {
      type: "text",
      text: message.text,
    },
    ...parts,
  ];
}

async function toAnthropicContent(message: EngineMessage): Promise<string | Array<Record<string, unknown>>> {
  if (!message.attachments?.length) {
    return message.text;
  }

  const { extractAttachmentText } = await import("../agent/attachments/extract");
  const path = await import("node:path");

  const parts = await Promise.all(
    message.attachments.map(async (attachment) => {
      if (attachment.kind === "image") {
        const dataUrl = await toImageDataUrl(attachment.localPath, attachment.mimeType);
        const [mediaType, base64] = parseDataUrl(dataUrl);
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64,
          },
        };
      }
      // file kind
      const extracted = await extractAttachmentText(attachment.localPath);
      const fileName = attachment.fileName ?? path.basename(attachment.localPath);
      return {
        type: "text",
        text: `\n--- Attachment: ${fileName} ---\n${extracted}\n--- End ---\n`,
      };
    })
  );

  return [
    {
      type: "text",
      text: message.text,
    },
    ...parts,
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

/**
 * 从 OpenAI compat 流帧抽 delta，分离 content（最终答案）vs reasoning（思考过程）。
 *
 * 字段语义（OpenAI 协议 + 各家扩展）：
 *   - delta.content                  最终答案（标准）
 *   - delta.reasoning_content        思考过程（LM Studio / DeepSeek R1 / Qwen3 reasoning）
 *   - delta.reasoning                思考过程（OpenRouter 风格）
 *
 * 设计（M1-F）：
 *   - 字段级分离：content 与 reasoning 走不同字段，无歧义
 *   - 调用方决定如何使用：runner / token budget 用 content 才算答案；CLI 可显示 reasoning
 *   - 保留 fallback 行为：当只有 reasoning 没 content 时，让 generator yield reasoning
 *     以维持 CLI 流式体验向后兼容；新调用方用 onContent / onReasoning callbacks 拿干净流
 */
interface OpenAiDeltaParts {
  content: string;
  reasoning: string;
}

function extractOpenAiDeltaParts(payload: unknown): OpenAiDeltaParts {
  const choice = (payload as {
    choices?: Array<{
      delta?: {
        content?: unknown;
        reasoning_content?: unknown;
        reasoning?: unknown;
      };
    }>;
  }).choices?.[0];
  const delta = choice?.delta;
  if (!delta) return { content: "", reasoning: "" };
  return {
    content: pickDeltaText(delta.content),
    reasoning: pickDeltaText(delta.reasoning_content) || pickDeltaText(delta.reasoning),
  };
}

function pickDeltaText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
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
  onUsage?: (usage: ProviderUsage) => void,
  tools?: ToolSchemaSpec[],
  onToolCall?: (call: ToolCallEvent) => void,
  onContent?: (chunk: string) => void,
  onReasoning?: (chunk: string) => void
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
        // 默认 4096 token 对常规答案够用；reasoning 模型需更大（reasoning + content 总和），
        // 用户可在 ~/.codeclaw/providers.json 用 maxTokens 字段覆盖（如 16384）。
        max_tokens: provider.maxTokens ?? 4096,
        messages: await toOpenAiMessages(messages),
        ...(tools && tools.length > 0
          ? {
              tools: tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })),
            }
          : {}),
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

  // M1-B：OpenAI tool_calls 流式分片解析
  // delta.tool_calls 是 [{ index, id?, type?, function: { name?, arguments? } }, ...]
  // index 稳定、id/name 第一帧给齐、arguments 是字符串分片，需累加；
  // finish_reason="tool_calls" 时 yield 全部累积事件
  const toolBuffers = new Map<number, { id: string; name: string; args: string }>();

  yield* streamSseLines(response, (payload) => {
    const parsed = JSON.parse(payload) as unknown;
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
    if (onToolCall) {
      const choice = (parsed as {
        choices?: Array<{
          delta?: { tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
          finish_reason?: string | null;
        }>;
      }).choices?.[0];
      const calls = choice?.delta?.tool_calls;
      if (Array.isArray(calls)) {
        for (const c of calls) {
          const idx = typeof c.index === "number" ? c.index : 0;
          const buf = toolBuffers.get(idx) ?? { id: "", name: "", args: "" };
          if (c.id) buf.id = c.id;
          if (c.function?.name) buf.name = c.function.name;
          if (typeof c.function?.arguments === "string") buf.args += c.function.arguments;
          toolBuffers.set(idx, buf);
        }
      }
      if (choice?.finish_reason === "tool_calls" || choice?.finish_reason === "stop") {
        for (const buf of toolBuffers.values()) {
          if (!buf.name) continue;
          let args: unknown = null;
          try {
            args = buf.args ? JSON.parse(buf.args) : {};
          } catch {
            args = null; // 保留 raw 让上层重试或错误回灌
          }
          onToolCall({ id: buf.id || `call-${Math.random().toString(36).slice(2, 10)}`, name: buf.name, args, raw: buf.args });
        }
        toolBuffers.clear();
      }
    }
    // M1-F：分别 fire content / reasoning callback；让调用方拿干净流
    const parts = extractOpenAiDeltaParts(parsed);
    if (onContent && parts.content) onContent(parts.content);
    if (onReasoning && parts.reasoning) onReasoning(parts.reasoning);
    return parts.content || parts.reasoning; // generator 仍 yield 合并流（向后兼容 CLI）
  });

  // 流结束时如果还有未触发的 buffer（finish_reason 缺失），兜底 yield
  if (onToolCall && toolBuffers.size > 0) {
    for (const buf of toolBuffers.values()) {
      if (!buf.name) continue;
      let args: unknown = null;
      try {
        args = buf.args ? JSON.parse(buf.args) : {};
      } catch {
        args = null;
      }
      onToolCall({ id: buf.id || `call-${Math.random().toString(36).slice(2, 10)}`, name: buf.name, args, raw: buf.args });
    }
    toolBuffers.clear();
  }
}

async function* streamAnthropic(
  provider: ProviderStatus,
  messages: EngineMessage[],
  fetchImpl: FetchLike,
  abortSignal?: AbortSignal,
  onUsage?: (usage: ProviderUsage) => void,
  tools?: ToolSchemaSpec[],
  onToolCall?: (call: ToolCallEvent) => void,
  onContent?: (chunk: string) => void
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
        max_tokens: provider.maxTokens ?? 1024,
        stream: true,
        ...(extractAnthropicSystem(messages) ? { system: extractAnthropicSystem(messages) } : {}),
        messages: await toAnthropicMessages(messages),
        ...(tools && tools.length > 0
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
              })),
            }
          : {}),
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
  // M1-B：tool_use content_block 解析。每个 block 一对 start/stop；input_json_delta 累加
  const toolBlocks = new Map<number, { id: string; name: string; partial: string }>();
  yield* streamSseLines(response, (payload) => {
    const parsed = JSON.parse(payload) as {
      type?: string;
      index?: number;
      delta?: { text?: string; type?: string; partial_json?: string };
      content_block?: { type?: string; id?: string; name?: string; input?: unknown };
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
    if (onToolCall) {
      if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
        const idx = typeof parsed.index === "number" ? parsed.index : 0;
        toolBlocks.set(idx, {
          id: parsed.content_block.id ?? `call-${Math.random().toString(36).slice(2, 10)}`,
          name: parsed.content_block.name ?? "",
          partial: "",
        });
      }
      if (parsed.type === "content_block_delta" && parsed.delta?.type === "input_json_delta") {
        const idx = typeof parsed.index === "number" ? parsed.index : 0;
        const buf = toolBlocks.get(idx);
        if (buf && typeof parsed.delta.partial_json === "string") {
          buf.partial += parsed.delta.partial_json;
        }
      }
      if (parsed.type === "content_block_stop") {
        const idx = typeof parsed.index === "number" ? parsed.index : 0;
        const buf = toolBlocks.get(idx);
        if (buf && buf.name) {
          let args: unknown = null;
          try {
            args = buf.partial ? JSON.parse(buf.partial) : {};
          } catch {
            args = null;
          }
          onToolCall({ id: buf.id, name: buf.name, args, raw: buf.partial });
          toolBlocks.delete(idx);
        }
      }
    }
    if (parsed.type === "content_block_delta" && parsed.delta?.type !== "input_json_delta") {
      const text = parsed.delta?.text ?? "";
      // M1-F：anthropic 也走 onContent 让 contentBuf 拿到内容（与 OpenAI / Ollama 对齐）
      if (onContent && text) onContent(text);
      return text;
    }
    return "";
  });
}

async function* streamOllama(
  provider: ProviderStatus,
  messages: EngineMessage[],
  fetchImpl: FetchLike,
  abortSignal?: AbortSignal,
  onUsage?: (usage: ProviderUsage) => void,
  onContent?: (chunk: string) => void
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
    const text = parsed.message?.content ?? "";
    // M1-F：让 ollama path 也走 onContent callback，与 OpenAI 流分离对齐；
    // 否则 queryEngine.contentBuf 拿不到 ollama 内容，最终 finalText 会落到
    // empty-response 兜底（只剩 generator yield 进 output 但 output 不再被采用）
    if (onContent && text) onContent(text);
    return text;
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
    /** #92 T8：禁用发请求前的 secret redact（测试 / 用户显式同意发原始 prompt） */
    disablePromptRedact?: boolean;
    /** M1-B：注入 native tool_use 工具 schemas */
    tools?: ToolSchemaSpec[];
    /** M1-B：流式解析出的 tool_call 事件回调（参数累积完成后才触发） */
    onToolCall?: (call: ToolCallEvent) => void;
    /** M1-F：每收到 OpenAI delta.content 分片回调（最终答案流） */
    onContent?: (chunk: string) => void;
    /** M1-F：每收到 reasoning_content / reasoning 分片回调（思考过程流） */
    onReasoning?: (chunk: string) => void;
  }
): AsyncGenerator<string> {
  const fetchImpl = options?.fetchImpl ?? fetch;

  // #92 T8：发给云端 LLM 前对 messages 做 secret redact
  // 默认开启；env CODECLAW_NO_PROMPT_REDACT=1 关；options.disablePromptRedact=true 单次关
  const { redactSecretsInMessages } = await import("../lib/redactPrompt");
  const redactResult = redactSecretsInMessages(messages, {
    disabled: options?.disablePromptRedact === true,
  });
  const safeMessages = redactResult.messages;

  if (provider.type === "anthropic") {
    yield* streamAnthropic(
      provider,
      safeMessages,
      fetchImpl,
      options?.abortSignal,
      options?.onUsage,
      options?.tools,
      options?.onToolCall,
      options?.onContent
    );
    return;
  }

  if (provider.type === "ollama") {
    yield* streamOllama(
      provider,
      safeMessages,
      fetchImpl,
      options?.abortSignal,
      options?.onUsage,
      options?.onContent,
    );
    return;
  }

  yield* streamOpenAiCompatible(
    provider,
    safeMessages,
    fetchImpl,
    options?.abortSignal,
    options?.onUsage,
    options?.tools,
    options?.onToolCall,
    options?.onContent,
    options?.onReasoning
  );
}
