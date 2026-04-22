import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createQueryEngine } from "../src/agent/queryEngine";
import { IngressGateway } from "../src/ingress/gateway";
import { CodeClawSdkClient } from "../src/sdk/client";
import { createGatewayRequestHandler } from "../src/sdk/httpServer";

type MockResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader: (name: string, value: string) => void;
  write: (chunk: string) => void;
  end: (chunk?: string) => void;
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createMockRequest(options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const serializedBody =
    options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body), "utf8")];
  const request = Readable.from(serializedBody) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };

  request.method = options.method;
  request.url = options.url;
  request.headers = options.headers ?? {};

  return request;
}

function createMockResponse(): MockResponse {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    write(chunk: string) {
      this.body += chunk;
    },
    end(chunk?: string) {
      if (chunk) {
        this.body += chunk;
      }
    }
  };
}

describe("sdk/http gateway", () => {
  it("serves health, JSON messages, and SSE streams through the same request handler", async () => {
    const queryEngine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "plan",
      workspace: process.cwd()
    });
    const ingressGateway = new IngressGateway(queryEngine);
    const handler = createGatewayRequestHandler({
      ingressGateway,
      queryEngine
    });

    const healthResponse = createMockResponse();
    await handler(
      createMockRequest({
        method: "GET",
        url: "/health"
      }) as never,
      healthResponse as never
    );
    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.body).toContain("\"status\":\"ok\"");

    const jsonResponse = createMockResponse();
    await handler(
      createMockRequest({
        method: "POST",
        url: "/v1/messages",
        body: {
          input: "help",
          userId: "sdk-user"
        }
      }) as never,
      jsonResponse as never
    );
    expect(jsonResponse.statusCode).toBe(200);
    expect(jsonResponse.body).toContain("\"channel\":\"http\"");
    expect(jsonResponse.body).toContain("Available commands");

    const sseResponse = createMockResponse();
    await handler(
      createMockRequest({
        method: "POST",
        url: "/v1/messages",
        headers: {
          accept: "text/event-stream"
        },
        body: {
          input: "doctor",
          userId: "sdk-user",
          stream: true
        }
      }) as never,
      sseResponse as never
    );
    expect(sseResponse.headers["content-type"]).toContain("text/event-stream");
    expect(sseResponse.body).toContain("data: ");
    expect(sseResponse.body).toContain("\"message-complete\"");
  });

  it("enforces bearer auth when the gateway token is configured", async () => {
    const queryEngine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "plan",
      workspace: process.cwd()
    });
    const ingressGateway = new IngressGateway(queryEngine);
    const handler = createGatewayRequestHandler({
      ingressGateway,
      queryEngine,
      authToken: "secret-token"
    });

    const unauthorizedResponse = createMockResponse();
    await handler(
      createMockRequest({
        method: "GET",
        url: "/health"
      }) as never,
      unauthorizedResponse as never
    );
    expect(unauthorizedResponse.statusCode).toBe(401);

    const authorizedResponse = createMockResponse();
    await handler(
      createMockRequest({
        method: "GET",
        url: "/health",
        headers: {
          authorization: "Bearer secret-token"
        }
      }) as never,
      authorizedResponse as never
    );
    expect(authorizedResponse.statusCode).toBe(200);
  });

  it("streams events through the SDK wrapper", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"sessionId":"session-1","traceId":"trace-1","channel":"http","timestamp":1,"payload":{"type":"message-complete","messageId":"msg-1","text":"done"}}\n\n'
              )
            );
            controller.close();
          }
        })
      )
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new CodeClawSdkClient("http://127.0.0.1:3000", "secret-token");
    const events = [];

    for await (const event of client.streamMessage({
      input: "help",
      userId: "sdk-user"
    })) {
      events.push(event);
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.type).toBe("message-complete");
  });
});
