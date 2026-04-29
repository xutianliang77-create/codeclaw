import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { IngressGateway } from "../ingress/gateway";
import type { EngineEvent, QueryEngine } from "../agent/types";
import type { GatewayEventEnvelope, GatewayHealthResponse, GatewayMessageRequest } from "./types";

function readBearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return null;
  }

  return header.slice("Bearer ".length).trim();
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(body) as T;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function writeSseEvent(response: ServerResponse, envelope: GatewayEventEnvelope<EngineEvent>): void {
  response.write(`data: ${JSON.stringify(envelope)}\n\n`);
}

export function startGatewayServer(options: {
  ingressGateway: IngressGateway;
  queryEngine: QueryEngine;
  port?: number;
  authToken?: string | null;
}): Promise<Server> {
  const server = createServer(createGatewayRequestHandler(options));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3000, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export function createGatewayRequestHandler(options: {
  ingressGateway: IngressGateway;
  queryEngine: QueryEngine;
  authToken?: string | null;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const authToken = options.authToken?.trim();
    if (authToken) {
      const bearerToken = readBearerToken(request);
      if (bearerToken !== authToken) {
        writeJson(response, 401, {
          error: "unauthorized"
        });
        return;
      }
    }

    if (request.method === "GET" && request.url === "/health") {
      const payload: GatewayHealthResponse = {
        status: "ok",
        service: "codeclaw-gateway"
      };
      writeJson(response, 200, payload);
      return;
    }

    if (request.method === "POST" && request.url === "/v1/interrupt") {
      const body = await readJsonBody<{ sessionId?: string }>(request);
      const sessionId = body.sessionId ?? options.queryEngine.getSessionId();
      options.ingressGateway.handleInterrupt(sessionId);
      writeJson(response, 200, {
        ok: true,
        sessionId
      });
      return;
    }

    if (request.method === "POST" && request.url === "/v1/messages") {
      const body = await readJsonBody<GatewayMessageRequest>(request);
      const stream = body.stream === true || request.headers.accept === "text/event-stream";
      const eventStream = options.ingressGateway.handleMessage({
        channel: "http",
        userId: body.userId ?? "http-user",
        sessionId: body.sessionId ?? null,
        input: body.input,
        priority: "normal",
        timestamp: Date.now(),
        metadata: {
          transport: "rest",
          source: body.input.trim().startsWith("/") ? "command" : "user"
        }
      });

      if (stream) {
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream; charset=utf-8");
        response.setHeader("cache-control", "no-cache");
        response.setHeader("connection", "keep-alive");

        for await (const envelope of eventStream) {
          writeSseEvent(response, envelope);
        }

        response.end();
        return;
      }

      let finalEnvelope: GatewayEventEnvelope<EngineEvent> | null = null;
      for await (const envelope of eventStream) {
        finalEnvelope = envelope;
      }

      writeJson(response, 200, {
        sessionId: finalEnvelope?.sessionId ?? options.queryEngine.getSessionId(),
        traceId: finalEnvelope?.traceId ?? null,
        channel: "http",
        messages: options.queryEngine.getVisibleMessages(),
        pendingApproval: options.queryEngine.getPendingApproval()
      });
      return;
    }

    writeJson(response, 404, {
      error: "not_found"
    });
  };
}
