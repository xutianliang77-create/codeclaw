import { describe, expect, it } from "vitest";
import type { EngineMessage } from "../src/agent/types";
import { streamProviderResponse } from "../src/provider/client";
import type { ProviderStatus } from "../src/provider/types";

function createResponse(body: string): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  }));
}

const baseProvider: ProviderStatus = {
  type: "openai",
  displayName: "OpenAI",
  kind: "cloud",
  enabled: true,
  requiresApiKey: true,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  timeoutMs: 30_000,
  apiKey: "test-key",
  apiKeyEnvVar: "OPENAI_API_KEY",
  envVars: ["OPENAI_API_KEY"],
  fileConfig: {},
  configured: true,
  available: true,
  reason: "configured"
};

const messages: EngineMessage[] = [
  {
    id: "u1",
    role: "user",
    text: "hello"
  }
];

describe("provider client", () => {
  it("parses openai-compatible sse deltas", async () => {
    const fetchImpl = async () =>
      createResponse(
        [
          'data: {"choices":[{"delta":{"content":"Hel"}}]}',
          'data: {"choices":[{"delta":{"content":"lo"}}]}',
          "data: [DONE]"
        ].join("\n")
      );

    const chunks: string[] = [];
    for await (const chunk of streamProviderResponse(baseProvider, messages, { fetchImpl: fetchImpl as typeof fetch })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("Hello");
  });

  it("parses ollama ndjson deltas", async () => {
    const fetchImpl = async () =>
      createResponse(
        [
          '{"message":{"content":"Hel"},"done":false}',
          '{"message":{"content":"lo"},"done":false}',
          '{"done":true}'
        ].join("\n")
      );

    const chunks: string[] = [];
    for await (const chunk of streamProviderResponse(
      {
        ...baseProvider,
        type: "ollama",
        displayName: "Ollama",
        kind: "local",
        requiresApiKey: false,
        baseUrl: "http://127.0.0.1:11434",
        apiKey: undefined,
        apiKeyEnvVar: undefined
      },
      messages,
      { fetchImpl: fetchImpl as typeof fetch }
    )) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("Hello");
  });

  it("does not abort an already-started local stream when timeoutMs is very small", async () => {
    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n'));
            }, 10);
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n'));
              controller.close();
            }, 20);
          }
        })
      );

    const chunks: string[] = [];
    for await (const chunk of streamProviderResponse(
      {
        ...baseProvider,
        type: "lmstudio",
        displayName: "LM Studio",
        kind: "local",
        requiresApiKey: false,
        baseUrl: "http://127.0.0.1:1234/v1",
        timeoutMs: 1,
        apiKey: undefined,
        apiKeyEnvVar: undefined
      },
      messages,
      { fetchImpl: fetchImpl as typeof fetch }
    )) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("Hello");
  });
});
