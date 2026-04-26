/**
 * SubagentRegistry 单测（B.8）
 */

import { describe, expect, it } from "vitest";
import { SubagentRegistry } from "../../../../src/agent/subagents/registry";

describe("SubagentRegistry", () => {
  it("start → finish ok 完整生命周期", () => {
    const r = new SubagentRegistry();
    const rec = r.start({ role: "Explore", prompt: "find auth handlers" });
    expect(rec.status).toBe("running");
    expect(rec.role).toBe("Explore");

    r.finish(rec.id, {
      ok: true,
      toolCallCount: 5,
      durationMs: 1200,
      resultText: "found 3 handlers",
    });
    const list = r.list();
    expect(list.length).toBe(1);
    expect(list[0].status).toBe("completed");
    expect(list[0].toolCallCount).toBe(5);
    expect(list[0].resultPreview).toContain("found 3 handlers");
  });

  it("start → finish 失败标 failed", () => {
    const r = new SubagentRegistry();
    const rec = r.start({ role: "Explore", prompt: "x" });
    r.finish(rec.id, { ok: false, error: "provider down", toolCallCount: 0, durationMs: 100 });
    expect(r.list()[0].status).toBe("failed");
    expect(r.list()[0].error).toBe("provider down");
  });

  it("error 含 'timeout' → status=timeout", () => {
    const r = new SubagentRegistry();
    const rec = r.start({ role: "Explore", prompt: "x" });
    r.finish(rec.id, {
      ok: false,
      error: "subagent exceeded 5min timeout",
      toolCallCount: 1,
      durationMs: 300_000,
    });
    expect(r.list()[0].status).toBe("timeout");
  });

  it("list 按最近的在前", () => {
    const r = new SubagentRegistry();
    const a = r.start({ role: "Explore", prompt: "a" });
    const b = r.start({ role: "Plan", prompt: "b" });
    const c = r.start({ role: "deep-reviewer", prompt: "c" });
    void a;
    void b;
    void c;
    expect(r.list().map((x) => x.role)).toEqual(["deep-reviewer", "Plan", "Explore"]);
  });

  it("超过 100 条切尾", () => {
    const r = new SubagentRegistry();
    for (let i = 0; i < 105; i++) {
      r.start({ role: "Explore", prompt: `n${i}` });
    }
    expect(r.size()).toBe(100);
  });

  it("finish 不存在的 id → noop", () => {
    const r = new SubagentRegistry();
    expect(() => r.finish("ghost", { ok: true, toolCallCount: 0, durationMs: 0 })).not.toThrow();
  });

  it("clear 清空", () => {
    const r = new SubagentRegistry();
    r.start({ role: "Explore", prompt: "x" });
    r.clear();
    expect(r.size()).toBe(0);
  });

  it("prompt 超 1024 字符截断", () => {
    const r = new SubagentRegistry();
    const long = "x".repeat(2000);
    const rec = r.start({ role: "Explore", prompt: long });
    expect(rec.prompt.length).toBe(1024);
  });

  it("resultText 截 256 字符", () => {
    const r = new SubagentRegistry();
    const rec = r.start({ role: "Explore", prompt: "x" });
    r.finish(rec.id, {
      ok: true,
      toolCallCount: 0,
      durationMs: 0,
      resultText: "y".repeat(500),
    });
    expect(r.list()[0].resultPreview!.length).toBe(256);
  });
});
