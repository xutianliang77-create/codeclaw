/**
 * Web channel adapter 单测
 */

import { describe, expect, it } from "vitest";
import { createWebIngressMessage } from "../../../../src/channels/web/adapter";

describe("createWebIngressMessage", () => {
  it("基本字段", () => {
    const msg = createWebIngressMessage("hello", { userId: "alice" });
    expect(msg.channel).toBe("http");
    expect(msg.userId).toBe("alice");
    expect(msg.sessionId).toBeNull();
    expect(msg.input).toBe("hello");
    expect(msg.priority).toBe("normal");
    expect(msg.metadata.transport).toBe("sse");
    expect(msg.metadata.source).toBe("user");
    expect(typeof msg.timestamp).toBe("number");
  });

  it("/ 开头视为 command source", () => {
    const msg = createWebIngressMessage("/help", { userId: "alice" });
    expect(msg.metadata.source).toBe("command");
  });

  it("/approve 标 high priority", () => {
    expect(createWebIngressMessage("/approve", { userId: "x" }).priority).toBe("high");
    expect(createWebIngressMessage("/approve abc", { userId: "x" }).priority).toBe("high");
    expect(createWebIngressMessage("/deny", { userId: "x" }).priority).toBe("high");
    expect(createWebIngressMessage("/deny xyz", { userId: "x" }).priority).toBe("high");
  });

  it("/approveX 不算 approval（精确前缀匹配）", () => {
    expect(createWebIngressMessage("/approveX", { userId: "x" }).priority).toBe("normal");
  });

  it("transport 可覆盖", () => {
    expect(
      createWebIngressMessage("hi", { userId: "x", transport: "ws" }).metadata.transport
    ).toBe("ws");
  });

  it("workspace 注入 channelSpecific", () => {
    const msg = createWebIngressMessage("hi", {
      userId: "alice",
      workspace: "/home/alice/proj",
    });
    expect(msg.metadata.channelSpecific).toEqual({ workspace: "/home/alice/proj" });
  });

  it("无 workspace 时 channelSpecific 为 undefined", () => {
    const msg = createWebIngressMessage("hi", { userId: "alice" });
    expect(msg.metadata.channelSpecific).toBeUndefined();
  });

  it("source hint 显式覆盖推断", () => {
    const msg = createWebIngressMessage("hello", { userId: "alice", source: "hook" });
    expect(msg.metadata.source).toBe("hook");
  });

  it("isInterrupt / parentToolUseId 透传", () => {
    const msg = createWebIngressMessage("interrupt", {
      userId: "alice",
      isInterrupt: true,
      parentToolUseId: "tool-123",
    });
    expect(msg.metadata.isInterrupt).toBe(true);
    expect(msg.metadata.parentToolUseId).toBe("tool-123");
  });
});
