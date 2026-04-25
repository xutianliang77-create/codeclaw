import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { WechatBotAdapter } from "./adapter";
import type { WechatDeliveryCard, WechatWebhookEvent, WechatWebhookRequest, WechatWebhookResponse } from "./types";
import { normalizeIlinkWebhookPayload } from "./ilink";
import { checkAndRegister, recordDelivery } from "../../ingress/dedupStore";

/**
 * dedup 选项：
 *   - dedupDb 不传 → 不去重（向后兼容）
 *   - 同 (channel='wechat', userId=senderId, client_id=messageId) ttl 内重复 → 跳过 receiveMessage
 *   - 处理完成后用 traceId/sessionId 回填 last_delivery，下次重复请求复用
 */
export interface WechatDedupOptions {
  dedupDb?: Database.Database;
}

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

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function resolveWebhookEvent(
  adapter: WechatBotAdapter,
  event: WechatWebhookEvent
): Promise<WechatDeliveryCard | null> {
  switch (event.type) {
    case "message":
      if (!event.message.text.trim() && !event.message.image && !event.message.audio) {
        return null;
      }
      return adapter.receiveMessage(event.message);
    case "resume":
      return adapter.buildResumeCard(event.contextToken);
    case "approval-notify":
      return adapter.buildApprovalNotificationCard(event.contextToken);
  }
}

export async function handleWechatWebhookEvents(
  adapter: WechatBotAdapter,
  request: WechatWebhookRequest,
  opts: WechatDedupOptions = {}
): Promise<WechatWebhookResponse> {
  const cards: WechatDeliveryCard[] = [];
  let dropped = 0;

  for (const event of request.events) {
    // 仅 message 事件做 dedup（resume / approval-notify 无 messageId）
    if (event.type === "message" && opts.dedupDb) {
      const r = checkAndRegister(opts.dedupDb, {
        clientId: event.message.messageId,
        channel: "wechat",
        userId: event.message.senderId,
      });
      if (r.isDuplicate) {
        // 复用上次 traceId/sessionId 让重试拿回相同 card
        if (r.lastDelivery && typeof r.lastDelivery === "object") {
          cards.push(r.lastDelivery as WechatDeliveryCard);
          continue;
        }
        // 上次未回填或 corrupt → 视为 drop（保险）
        dropped += 1;
        continue;
      }
    }

    const card = await resolveWebhookEvent(adapter, event);
    if (card) {
      cards.push(card);
      // 回填 delivery：含 traceId / contextToken；下次重复请求短路复用
      if (event.type === "message" && opts.dedupDb) {
        recordDelivery(opts.dedupDb, event.message.messageId, card);
      }
      continue;
    }

    dropped += 1;
  }

  return {
    ok: true,
    cards,
    dropped
  };
}

export async function handleIlinkWebhookPayload(
  adapter: WechatBotAdapter,
  payload: unknown,
  opts: WechatDedupOptions = {}
): Promise<WechatWebhookResponse> {
  const request = normalizeIlinkWebhookPayload(payload as Parameters<typeof normalizeIlinkWebhookPayload>[0]);
  return handleWechatWebhookEvents(adapter, request, opts);
}

export function buildWechatApprovalSweep(adapter: WechatBotAdapter): WechatWebhookResponse {
  const cards = adapter.buildPendingApprovalCards();
  return {
    ok: true,
    cards,
    dropped: 0
  };
}

export function createWechatWebhookRequestHandler(options: {
  adapter: WechatBotAdapter;
  authToken?: string | null;
  dedupDb?: Database.Database;
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
      writeJson(response, 200, {
        status: "ok",
        service: "codeclaw-wechat-adapter"
      });
      return;
    }

    if (request.method === "POST" && request.url === "/v1/wechat/events") {
      const body = await readJsonBody<unknown>(request);
      const result = await handleIlinkWebhookPayload(options.adapter, body, {
        dedupDb: options.dedupDb,
      });
      writeJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && request.url === "/v1/wechat/approvals/sweep") {
      const result = buildWechatApprovalSweep(options.adapter);
      writeJson(response, 200, result);
      return;
    }

    writeJson(response, 404, {
      error: "not_found"
    });
  };
}

export function startWechatWebhookServer(options: {
  adapter: WechatBotAdapter;
  port?: number;
  authToken?: string | null;
  dedupDb?: Database.Database;
}): Promise<Server> {
  const server = createServer(createWechatWebhookRequestHandler(options));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3100, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
