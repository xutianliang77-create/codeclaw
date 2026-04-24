import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { createQueryEngine } from "../src/agent/queryEngine";
import { WechatBotAdapter } from "../src/channels/wechat/adapter";
import {
  buildWechatApprovalSweep,
  createWechatWebhookRequestHandler,
  handleIlinkWebhookPayload,
  handleWechatWebhookEvents
} from "../src/channels/wechat/handler";

type MockResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader: (name: string, value: string) => void;
  end: (chunk?: string) => void;
};

function createAdapter(): WechatBotAdapter {
  return new WechatBotAdapter(() =>
    createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "plan",
      workspace: process.cwd()
    })
  );
}

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
    end(chunk?: string) {
      if (chunk) {
        this.body += chunk;
      }
    }
  };
}

describe("wechat handler", () => {
  it("handles message, resume, and approval-notify events in one webhook batch", async () => {
    const adapter = createAdapter();

    const first = await handleWechatWebhookEvents(adapter, {
      events: [
        {
          type: "message",
          message: {
            messageId: "msg-1",
            senderId: "user-1",
            chatId: "chat-a",
            text: "/write a.ts :: hello"
          }
        }
      ]
    });

    const contextToken = first.cards[0]?.contextToken;
    const result = await handleWechatWebhookEvents(adapter, {
      events: [
        {
          type: "resume",
          contextToken: contextToken as string
        },
        {
          type: "approval-notify",
          contextToken: contextToken as string
        },
        {
          type: "message",
          message: {
            messageId: "msg-2",
            senderId: "user-1",
            chatId: "chat-a",
            text: "   "
          }
        }
      ]
    });

    expect(result.ok).toBe(true);
    expect(result.cards).toHaveLength(2);
    expect(result.dropped).toBe(1);
    expect(result.cards[0]?.markdown).toContain("# CodeClaw 会话恢复");
    expect(result.cards[1]?.markdown).toContain("# CodeClaw 审批通知");
  });

  it("normalizes raw iLink-style payloads before handling them", async () => {
    const adapter = createAdapter();

    const result = await handleIlinkWebhookPayload(adapter, {
      events: [
        {
          event: "message",
          message: {
            id: "msg-1",
            content: {
              text: "/help"
            }
          },
          sender: {
            id: "user-1",
            name: "Alice"
          },
          chat: {
            id: "room-1",
            type: "group"
          },
          context_token: "ctx-1",
          mention_self: true
        }
      ]
    });

    expect(result.ok).toBe(true);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]?.markdown).toContain("CodeClaw 微信 Bot");
    expect(result.cards[0]?.contextToken).toBeDefined();
  });

  it("accepts image-only iLink protocol payloads", async () => {
    const adapter = createAdapter();

    const result = await handleIlinkWebhookPayload(adapter, {
      msgs: [
        {
          from_user_id: "user-1",
          client_id: "msg-img-1",
          message_type: 1,
          item_list: [
            {
              type: 2,
              image_item: {
                file_name: "sample.png",
                mime_type: "image/png",
                width: 320,
                height: 240
              }
            }
          ]
        }
      ]
    });

    expect(result.ok).toBe(true);
    expect(result.cards).toHaveLength(1);
  });

  it("accepts audio-only iLink protocol payloads", async () => {
    const adapter = createAdapter();

    const result = await handleIlinkWebhookPayload(adapter, {
      msgs: [
        {
          from_user_id: "user-1",
          client_id: "msg-audio-1",
          message_type: 1,
          item_list: [
            {
              type: 3,
              audio_item: {
                file_name: "voice.mp3",
                mime_type: "audio/mpeg",
                duration_ms: 2000
              }
            }
          ]
        }
      ]
    });

    expect(result.ok).toBe(true);
    expect(result.cards).toHaveLength(1);
  });

  it("can sweep pending approvals into cards for outbound notify jobs", async () => {
    const adapter = createAdapter();

    await handleWechatWebhookEvents(adapter, {
      events: [
        {
          type: "message",
          message: {
            messageId: "msg-1",
            senderId: "user-1",
            chatId: "chat-a",
            text: "/write a.ts :: hello"
          }
        }
      ]
    });

    const result = buildWechatApprovalSweep(adapter);

    expect(result.ok).toBe(true);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]?.markdown).toContain("tool: write");
  });

  it("serves health and webhook responses through the request handler", async () => {
    const handler = createWechatWebhookRequestHandler({
      adapter: createAdapter()
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
    expect(healthResponse.body).toContain("\"service\":\"codeclaw-wechat-adapter\"");

    const webhookResponse = createMockResponse();
    await handler(
      createMockRequest({
        method: "POST",
        url: "/v1/wechat/events",
        body: {
          msgs: [
            {
              from_user_id: "user-1",
              client_id: "msg-1",
              message_type: 1,
              item_list: [
                {
                  type: 1,
                  text_item: {
                    text: "/help"
                  }
                }
              ]
            }
          ]
        }
      }) as never,
      webhookResponse as never
    );

    expect(webhookResponse.statusCode).toBe(200);
    expect(webhookResponse.body).toContain("\"ok\":true");
    expect(webhookResponse.body).toContain("CodeClaw 微信 Bot");

    const sweepResponse = createMockResponse();
    await handler(
      createMockRequest({
        method: "POST",
        url: "/v1/wechat/approvals/sweep"
      }) as never,
      sweepResponse as never
    );

    expect(sweepResponse.statusCode).toBe(200);
    expect(sweepResponse.body).toContain("\"ok\":true");
  });

  it("enforces bearer auth when the webhook token is configured", async () => {
    const handler = createWechatWebhookRequestHandler({
      adapter: createAdapter(),
      authToken: "wechat-secret"
    });

    const unauthorizedResponse = createMockResponse();
    await handler(
      createMockRequest({
        method: "GET",
        url: "/health"
      }) as never,
      unauthorizedResponse as never
    );

    const authorizedResponse = createMockResponse();
    await handler(
      createMockRequest({
        method: "GET",
        url: "/health",
        headers: {
          authorization: "Bearer wechat-secret"
        }
      }) as never,
      authorizedResponse as never
    );

    expect(unauthorizedResponse.statusCode).toBe(401);
    expect(authorizedResponse.statusCode).toBe(200);
  });
});
