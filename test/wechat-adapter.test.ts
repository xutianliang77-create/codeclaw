import { describe, expect, it } from "vitest";
import { createQueryEngine } from "../src/agent/queryEngine";
import {
  buildWechatContextMapping,
  buildWechatScopedUserId,
  createWechatIngressMessage,
  WechatBotAdapter
} from "../src/channels/wechat/adapter";

async function collect(stream: AsyncGenerator<unknown>): Promise<void> {
  while (true) {
    const next = await stream.next();
    if (next.done) {
      return;
    }
  }
}

describe("wechat adapter", () => {
  it("maps iLink-style inbound message context into a scoped ingress message", () => {
    const scopedUserId = buildWechatScopedUserId({
      messageId: "msg-1",
      senderId: "user-1",
      senderName: "Alice",
      chatId: "room-1",
      chatType: "room",
      text: "/resume",
      contextToken: "ctx-1"
    });

    const mapping = buildWechatContextMapping({
      messageId: "msg-1",
      senderId: "user-1",
      senderName: "Alice",
      chatId: "room-1",
      chatType: "room",
      text: "/resume",
      contextToken: "ctx-1"
    });
    const ingress = createWechatIngressMessage({
      messageId: "msg-1",
      senderId: "user-1",
      senderName: "Alice",
      chatId: "room-1",
      chatType: "room",
      text: "/resume",
      contextToken: "ctx-1"
    });

    expect(scopedUserId).toBe("wechat:room:room-1:user-1");
    expect(mapping.contextToken).toBe("ctx-1");
    expect(ingress.channel).toBe("wechat");
    expect(ingress.userId).toBe(scopedUserId);
    expect(ingress.priority).toBe("high");
    expect(ingress.metadata.channelSpecific).toMatchObject({
      chatId: "room-1",
      chatType: "room",
      senderId: "user-1",
      senderName: "Alice",
      contextToken: "ctx-1"
    });
  });

  it("creates and continues chat-scoped sessions with markdown card output", async () => {
    const adapter = new WechatBotAdapter(() =>
      createQueryEngine({
        currentProvider: null,
        fallbackProvider: null,
        permissionMode: "plan",
        workspace: process.cwd()
      })
    );

    const first = await adapter.receiveMessage({
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-a",
      text: "/help"
    });
    const second = await adapter.receiveMessage({
      messageId: "msg-2",
      senderId: "user-1",
      chatId: "chat-a",
      text: "/status"
    });
    const third = await adapter.receiveMessage({
      messageId: "msg-3",
      senderId: "user-1",
      chatId: "chat-b",
      text: "/status"
    });

    expect(first.contextToken).toBe(second.contextToken);
    expect(first.contextToken).not.toBe(third.contextToken);
    expect(adapter.getActiveSessions()).toHaveLength(2);
    expect(second.markdown).toContain("# CodeClaw 微信 Bot");
    expect(second.markdown).toContain("## 最新回复");
    expect(second.markdown).toContain("## 最新输入");
    expect(second.markdown).not.toContain("- session:");
    expect(second.markdown).not.toContain("- trace:");
    expect(second.markdown).not.toContain("- context:");
  });

  it("builds approval notify and resume cards from the shared approval model", async () => {
    const adapter = new WechatBotAdapter(() =>
      createQueryEngine({
        currentProvider: null,
        fallbackProvider: null,
        permissionMode: "plan",
        workspace: process.cwd()
      })
    );

    const reply = await adapter.receiveMessage({
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-a",
      text: "/write scratch.ts :: hello"
    });

    const approvalCard = adapter.buildApprovalNotificationCard(reply.contextToken);
    const resumeCard = adapter.buildResumeCard(reply.contextToken);

    expect(reply.pendingApproval).toBe(true);
    expect(reply.markdown).toContain("## 待审批");
    expect(reply.markdown).toContain("/approve");
    expect(approvalCard?.markdown).toContain("# CodeClaw 审批通知");
    expect(approvalCard?.markdown).toContain("tool: write");
    expect(resumeCard?.markdown).toContain("# CodeClaw 会话恢复");
    expect(resumeCard?.markdown).toContain("detail: scratch.ts");
  });

  it("can collect approval cards across active sessions for notification sweep", async () => {
    const adapter = new WechatBotAdapter(() =>
      createQueryEngine({
        currentProvider: null,
        fallbackProvider: null,
        permissionMode: "plan",
        workspace: process.cwd()
      })
    );

    await adapter.receiveMessage({
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-a",
      text: "/write a.ts :: hello"
    });
    await adapter.receiveMessage({
      messageId: "msg-2",
      senderId: "user-2",
      chatId: "chat-b",
      text: "/help"
    });

    const cards = adapter.buildPendingApprovalCards();

    expect(cards).toHaveLength(1);
    expect(cards[0]?.markdown).toContain("# CodeClaw 审批通知");
    expect(cards[0]?.markdown).toContain("tool: write");
  });

  it("can attach wechat traffic to an existing shared session runtime", async () => {
    const sharedEngine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "plan",
      workspace: process.cwd()
    });
    const adapter = new WechatBotAdapter(() =>
      createQueryEngine({
        currentProvider: null,
        fallbackProvider: null,
        permissionMode: "plan",
        workspace: process.cwd()
      })
    );

    adapter.attachSharedRuntime(sharedEngine);

    const reply = await adapter.receiveMessage({
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-a",
      text: "/status"
    });

    expect(reply.sessionId).toBe(sharedEngine.getSessionId());
    expect(reply.contextToken).toBe(sharedEngine.getSessionId());
    expect(adapter.getActiveSessions()).toEqual([
      {
        userKey: "wechat:direct:chat-a:user-1",
        sessionId: sharedEngine.getSessionId()
      }
    ]);
  });

  it("prefers the explicitly attached shared session over a stale context token", async () => {
    const adapter = new WechatBotAdapter(() =>
      createQueryEngine({
        currentProvider: null,
        fallbackProvider: null,
        permissionMode: "plan",
        workspace: process.cwd()
      })
    );

    const oldReply = await adapter.receiveMessage({
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-a",
      text: "/help"
    });
    const sharedEngine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "plan",
      workspace: process.cwd()
    });

    adapter.attachSharedRuntime(sharedEngine);

    const reboundReply = await adapter.receiveMessage({
      messageId: "msg-2",
      senderId: "user-1",
      chatId: "chat-a",
      text: "/status",
      contextToken: oldReply.contextToken
    });

    expect(reboundReply.sessionId).toBe(sharedEngine.getSessionId());
    expect(reboundReply.contextToken).toBe(sharedEngine.getSessionId());
    expect(reboundReply.contextToken).not.toBe(oldReply.contextToken);
    expect(adapter.getActiveSessions()).toEqual([
      {
        userKey: "wechat:direct:chat-a:user-1",
        sessionId: sharedEngine.getSessionId()
      }
    ]);
  });

  it("builds session sync cards for shared session updates created outside wechat", async () => {
    const sharedEngine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "plan",
      workspace: process.cwd()
    });
    const adapter = new WechatBotAdapter(() =>
      createQueryEngine({
        currentProvider: null,
        fallbackProvider: null,
        permissionMode: "plan",
        workspace: process.cwd()
      })
    );

    adapter.attachSharedRuntime(sharedEngine);
    await adapter.receiveMessage({
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-a",
      text: "/help"
    });

    await collect(sharedEngine.submitMessage("remember this cli note"));

    const cards = adapter.buildSessionUpdateCards();

    expect(cards).toHaveLength(1);
    expect(cards[0]?.markdown).toContain("# CodeClaw 会话同步");
    expect(cards[0]?.markdown).toContain("## 最新输入");
    expect(cards[0]?.markdown).toContain("remember this cli note");
    expect(cards[0]?.markdown).toContain("## 最新回复");
  });
});
