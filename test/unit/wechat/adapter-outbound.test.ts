/**
 * #116 阶段 🅑：WechatBotAdapter 外发队列单测
 */

import { describe, expect, it } from "vitest";
import { createQueryEngine } from "../../../src/agent/queryEngine";
import { WechatBotAdapter } from "../../../src/channels/wechat/adapter";
import { handleWechatWebhookEvents } from "../../../src/channels/wechat/handler";

function createAdapter(): WechatBotAdapter {
  return new WechatBotAdapter(() =>
    createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "plan",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
    })
  );
}

async function seedRuntime(adapter: WechatBotAdapter): Promise<void> {
  // 让 adapter 看到一条用户消息以建立 runtime + lastContext
  await handleWechatWebhookEvents(adapter, {
    events: [
      {
        type: "message",
        message: {
          messageId: "m1",
          senderId: "user-1",
          chatId: "chat-a",
          text: "hello",
        },
      },
    ],
  });
}

describe("WechatBotAdapter 外发队列", () => {
  it("无 active 接收方 → enqueueOutboundText 返 false", () => {
    const a = createAdapter();
    expect(a.outboundQueueSize()).toBe(0);
    expect(a.enqueueOutboundText("hello")).toBe(false);
    expect(a.outboundQueueSize()).toBe(0);
  });

  it("有 lastContext 后入队成功", async () => {
    const a = createAdapter();
    await seedRuntime(a);
    expect(a.enqueueOutboundText("[Cron · daily-rag · ok · 1234ms]\nindexed 12 files")).toBe(true);
    expect(a.outboundQueueSize()).toBe(1);
  });

  it("drainOutboundQueue 清空 + 返出全部", async () => {
    const a = createAdapter();
    await seedRuntime(a);
    a.enqueueOutboundText("first");
    a.enqueueOutboundText("second");
    expect(a.outboundQueueSize()).toBe(2);
    const drained = a.drainOutboundQueue();
    expect(drained.length).toBe(2);
    expect(drained.map((c) => c.markdown)).toEqual(["first", "second"]);
    expect(a.outboundQueueSize()).toBe(0);
  });

  it("超过 100 条切尾", async () => {
    const a = createAdapter();
    await seedRuntime(a);
    for (let i = 0; i < 105; i++) a.enqueueOutboundText(`msg-${i}`);
    expect(a.outboundQueueSize()).toBe(100);
    const drained = a.drainOutboundQueue();
    // 最早 5 条被切；保留 5..104
    expect(drained[0].markdown).toBe("msg-5");
    expect(drained[drained.length - 1].markdown).toBe("msg-104");
  });

  it("入队卡片含 replyTarget（指向最后活跃用户）", async () => {
    const a = createAdapter();
    await seedRuntime(a);
    a.enqueueOutboundText("ping");
    const drained = a.drainOutboundQueue();
    expect(drained[0].replyTarget).toBeDefined();
    expect(drained[0].replyTarget?.senderId).toBe("user-1");
  });
});
