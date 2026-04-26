/**
 * Status line 数据层单测（M3-04 step 4+5）
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  buildDefaultStatusLine,
  startCustomStatusLine,
} from "../../../src/hooks/statusLine";

describe("buildDefaultStatusLine", () => {
  it("空输入 → '(no status)'", () => {
    expect(buildDefaultStatusLine({})).toBe("(no status)");
  });

  it("只有 provider/model", () => {
    expect(buildDefaultStatusLine({ providerLabel: "openai", modelLabel: "gpt-4.1" })).toBe(
      "openai/gpt-4.1"
    );
  });

  it("provider 缺失 → '?/<model>'", () => {
    expect(buildDefaultStatusLine({ modelLabel: "gpt-4.1" })).toBe("?/gpt-4.1");
  });

  it("含 contextUsed + contextLimit → 百分比", () => {
    expect(
      buildDefaultStatusLine({
        providerLabel: "anthropic",
        modelLabel: "sonnet",
        contextUsed: 1500,
        contextLimit: 8000,
      })
    ).toBe("anthropic/sonnet · ctx 1500/8000 (19%)");
  });

  it("含 contextUsed 但无 limit → 仅展示 used", () => {
    expect(
      buildDefaultStatusLine({ providerLabel: "x", modelLabel: "y", contextUsed: 500 })
    ).toBe("x/y · ctx 500");
  });

  it("permissionMode + workspace 显示", () => {
    expect(
      buildDefaultStatusLine({
        providerLabel: "openai",
        modelLabel: "gpt-4o",
        permissionMode: "plan",
        workspace: "/home/user/CodeClaw",
      })
    ).toBe("openai/gpt-4o · plan · cwd:CodeClaw");
  });

  it("workspace 是相对路径 → basename", () => {
    expect(buildDefaultStatusLine({ workspace: "myproj" })).toBe("cwd:myproj");
  });
});

describe("startCustomStatusLine", () => {
  const handles: Array<{ stop(): void }> = [];

  afterEach(() => {
    while (handles.length) handles.pop()?.stop();
  });

  it("立即跑一次 + onUpdate 收到 stdout trim", async () => {
    const updates: string[] = [];
    const h = startCustomStatusLine({
      command: "echo 'live status'",
      intervalMs: 600,
      onUpdate: (t) => updates.push(t),
    });
    handles.push(h);
    // 等首次 spawn 完成
    await new Promise((r) => setTimeout(r, 200));
    expect(updates[0]).toBe("live status");
  });

  it("intervalMs polling：300ms 内至少 2 次 update", async () => {
    const updates: string[] = [];
    const h = startCustomStatusLine({
      command: "date +%s%N",
      intervalMs: 600, // clamp to 600
      onUpdate: (t) => updates.push(t),
    });
    handles.push(h);
    // 第一次立即；第二次 intervalMs (600) 后
    await new Promise((r) => setTimeout(r, 800));
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0]).not.toBe(updates[1]); // 时间戳变化
  });

  it("非 0 exit → onError，并按 fallbackText 更新", async () => {
    const updates: string[] = [];
    const errors: Error[] = [];
    const h = startCustomStatusLine({
      command: "echo bad >&2; exit 1",
      intervalMs: 1000,
      fallbackText: "[fallback]",
      onUpdate: (t) => updates.push(t),
      onError: (e) => errors.push(e),
    });
    handles.push(h);
    await new Promise((r) => setTimeout(r, 200));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(updates).toContain("[fallback]");
  });

  it("timeout → onError + fallback", async () => {
    const updates: string[] = [];
    const errors: Error[] = [];
    const h = startCustomStatusLine({
      command: "sleep 5",
      intervalMs: 1000,
      timeoutMs: 100,
      fallbackText: "[timed out]",
      onUpdate: (t) => updates.push(t),
      onError: (e) => errors.push(e),
    });
    handles.push(h);
    await new Promise((r) => setTimeout(r, 250));
    expect(errors.some((e) => /timeout/.test(e.message))).toBe(true);
    expect(updates).toContain("[timed out]");
  });

  it("stop() 后不再触发 update", async () => {
    const updates: string[] = [];
    const h = startCustomStatusLine({
      command: "echo tick",
      intervalMs: 600,
      onUpdate: (t) => updates.push(t),
    });
    await new Promise((r) => setTimeout(r, 100)); // 等首次完成
    h.stop();
    const countAtStop = updates.length;
    await new Promise((r) => setTimeout(r, 800)); // 等下个 interval 周期过
    expect(updates.length).toBe(countAtStop);
  });

  it("intervalMs < 500 被 clamp 到 500", async () => {
    // 难以直接断言 interval；间接验证：50ms 设置不会让 update 高频堆积
    const updates: string[] = [];
    const h = startCustomStatusLine({
      command: "echo x",
      intervalMs: 50,
      onUpdate: (t) => updates.push(t),
    });
    handles.push(h);
    await new Promise((r) => setTimeout(r, 600));
    // 600ms 内 clamp=500 应该跑 1-2 次（首次立即 + ≤1 次 interval）
    expect(updates.length).toBeLessThanOrEqual(2);
  });
});
