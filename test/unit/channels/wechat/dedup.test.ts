/**
 * WeChat ingress dedup 接入 + traceId 透传 e2e
 *
 * 不构造完整 WechatBotAdapter，直接 mock 出 receiveMessage / buildResumeCard /
 * buildApprovalNotificationCard，专注验证 handler 层 dedup + traceId 透传。
 *
 * 覆盖：
 *   - 不传 dedupDb → receiveMessage 每次都调（向后兼容）
 *   - 同 messageId 二次 → receiveMessage 仅调 1 次，dedup 命中复用上次 card（含相同 traceId）
 *   - 不同 messageId → 各自处理
 *   - resume / approval-notify 类型不去重（无 messageId）
 *   - traceId e2e：第一次 receiveMessage 返回的 traceId，第二次重复请求短路返回相同 traceId
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";

import {
  handleWechatWebhookEvents,
  handleIlinkWebhookPayload,
} from "../../../../src/channels/wechat/handler";
import type { WechatBotAdapter } from "../../../../src/channels/wechat/adapter";
import type {
  WechatDeliveryCard,
  WechatInboundMessage,
  WechatWebhookRequest,
} from "../../../../src/channels/wechat/types";
import { openDataDb } from "../../../../src/storage/db";

const tempDirs: string[] = [];
let dedupDb: Database.Database;

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-wechat-dedup-"));
  tempDirs.push(dir);
  dedupDb = openDataDb({ path: path.join(dir, "data.db"), singleton: false }).db;
});

afterEach(() => {
  try { dedupDb.close(); } catch { /* ignore */ }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function buildMessage(messageId: string, senderId = "u-alice"): WechatInboundMessage {
  return {
    messageId,
    senderId,
    senderName: "Alice",
    chatId: "c-1",
    chatType: "direct",
    text: "hello",
    timestamp: Date.now(),
  };
}

function buildAdapter(args: {
  cardForMessage?: (msg: WechatInboundMessage) => WechatDeliveryCard | null;
  cardForResume?: (token: string) => WechatDeliveryCard | null;
}): { adapter: WechatBotAdapter; spy: { receiveMessage: ReturnType<typeof vi.fn> } } {
  const receiveMessage = vi.fn(async (msg: WechatInboundMessage) => {
    // 显式注入即用（包括 null）；未注入才走默认 card
    if (args.cardForMessage) return args.cardForMessage(msg);
    return {
      sessionId: "s-1",
      traceId: `trace-${msg.messageId}`,
      contextToken: "ctx-1",
      markdown: `reply to ${msg.text}`,
      pendingApproval: false,
    };
  });
  const adapter = {
    receiveMessage,
    buildResumeCard: vi.fn(args.cardForResume ?? (() => ({
      sessionId: "s-1",
      traceId: "trace-resume",
      contextToken: "ctx-1",
      markdown: "resume",
      pendingApproval: false,
    }))),
    buildApprovalNotificationCard: vi.fn(() => null),
  } as unknown as WechatBotAdapter;
  return { adapter, spy: { receiveMessage } };
}

describe("WeChat dedup · handleWechatWebhookEvents", () => {
  it("不传 dedupDb → 每次都调 receiveMessage（向后兼容）", async () => {
    const { adapter, spy } = buildAdapter({});
    const req: WechatWebhookRequest = {
      events: [
        { type: "message", message: buildMessage("m-1") },
        { type: "message", message: buildMessage("m-1") }, // 同 messageId，但无 dedup
      ],
    };

    const r = await handleWechatWebhookEvents(adapter, req); // 无 opts
    expect(spy.receiveMessage).toHaveBeenCalledTimes(2);
    expect(r.cards).toHaveLength(2);
    expect(r.dropped).toBe(0);
  });

  it("有 dedupDb · 同 messageId 二次 → receiveMessage 仅调 1 次，复用 card（含相同 traceId）", async () => {
    const { adapter, spy } = buildAdapter({});
    const req: WechatWebhookRequest = {
      events: [
        { type: "message", message: buildMessage("m-dup") },
        { type: "message", message: buildMessage("m-dup") },
      ],
    };

    const r = await handleWechatWebhookEvents(adapter, req, { dedupDb });
    expect(spy.receiveMessage).toHaveBeenCalledTimes(1);
    // 两张 card：第一张是真实 receive，第二张从 last_delivery 复用
    expect(r.cards).toHaveLength(2);
    // traceId e2e：两次返回的 traceId 完全一致
    expect(r.cards[0].traceId).toBe("trace-m-dup");
    expect(r.cards[1].traceId).toBe(r.cards[0].traceId);
    expect(r.cards[1].sessionId).toBe(r.cards[0].sessionId);
    expect(r.cards[1].contextToken).toBe(r.cards[0].contextToken);
  });

  it("不同 messageId → 各自处理", async () => {
    const { adapter, spy } = buildAdapter({});
    const req: WechatWebhookRequest = {
      events: [
        { type: "message", message: buildMessage("m-a") },
        { type: "message", message: buildMessage("m-b") },
      ],
    };

    const r = await handleWechatWebhookEvents(adapter, req, { dedupDb });
    expect(spy.receiveMessage).toHaveBeenCalledTimes(2);
    expect(r.cards.map((c) => c.traceId).sort()).toEqual(["trace-m-a", "trace-m-b"]);
  });

  it("跨用户同 messageId → 各自处理（保险设计）", async () => {
    const { adapter, spy } = buildAdapter({});
    const req: WechatWebhookRequest = {
      events: [
        { type: "message", message: buildMessage("m-shared", "u-alice") },
        { type: "message", message: buildMessage("m-shared", "u-bob") },
      ],
    };

    const r = await handleWechatWebhookEvents(adapter, req, { dedupDb });
    expect(spy.receiveMessage).toHaveBeenCalledTimes(2);
    expect(r.cards).toHaveLength(2);
  });

  it("resume / approval-notify 类型无 messageId → 不去重", async () => {
    const { adapter } = buildAdapter({});
    const req: WechatWebhookRequest = {
      events: [
        { type: "resume", contextToken: "ctx-1" },
        { type: "resume", contextToken: "ctx-1" },
      ],
    };

    const r = await handleWechatWebhookEvents(adapter, req, { dedupDb });
    expect(r.cards).toHaveLength(2); // 都通过
  });

  it("receiveMessage 返回 null（消息被 adapter 丢弃）→ dropped++ 不污染 dedup", async () => {
    const { adapter, spy } = buildAdapter({
      cardForMessage: () => null,
    });
    const req: WechatWebhookRequest = {
      events: [{ type: "message", message: buildMessage("m-dropped") }],
    };

    const r = await handleWechatWebhookEvents(adapter, req, { dedupDb });
    expect(spy.receiveMessage).toHaveBeenCalledTimes(1);
    expect(r.cards).toHaveLength(0);
    expect(r.dropped).toBe(1);
  });
});

describe("WeChat dedup · handleIlinkWebhookPayload (worker 真实入口)", () => {
  it("透传 dedupDb 到 handleWechatWebhookEvents", async () => {
    const { adapter, spy } = buildAdapter({});
    const ilinkPayload = {
      msgs: [
        {
          from_user_id: "u-alice",
          to_user_id: "bot-x",
          client_id: "msg-ilink-1",
          message_type: 1,
          context_token: "",
          item_list: [{ type: 1, text_item: { text: "hi from ilink" } }],
        },
        {
          // 重复推送：同 client_id → 短路
          from_user_id: "u-alice",
          to_user_id: "bot-x",
          client_id: "msg-ilink-1",
          message_type: 1,
          context_token: "",
          item_list: [{ type: 1, text_item: { text: "hi from ilink" } }],
        },
      ],
    };

    const r = await handleIlinkWebhookPayload(adapter, ilinkPayload, { dedupDb });
    // ilink 的 client_id 派生为 messageId（normalizeIlinkWebhookPayload 行为）
    // 两条入帧只走 receiveMessage 一次
    expect(spy.receiveMessage).toHaveBeenCalledTimes(1);
    expect(r.cards).toHaveLength(2);
    expect(r.cards[0].traceId).toBe(r.cards[1].traceId);
  });
});
