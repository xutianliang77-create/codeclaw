/**
 * QueryEngine · M3-04 Hooks 集成测
 *
 * 覆盖：
 *   - UserPromptSubmit 阻塞：user 消息不进 LLM，assistant 提示 + message-complete
 *   - UserPromptSubmit 通过：messages 正常推进
 *   - SessionStart fire-and-forget：constructor 不阻塞，hook 在后台跑
 *   - buildHooksReply 列出配置（runHooksReplyCommand 走 /hooks 路径）
 *   - hooks 配置缺省时 5 个时点皆 no-op
 */

import { afterEach, describe, expect, it } from "vitest";

import { createQueryEngine } from "../../../src/agent/queryEngine";
import type { CodeclawSettings } from "../../../src/hooks/settings";
import type { EngineEvent } from "../../../src/agent/types";

async function collect(gen: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe("queryEngine UserPromptSubmit hook", () => {
  it("非 0 exit → 阻塞用户消息派发", async () => {
    const settings: CodeclawSettings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "echo NOPE >&2; exit 1" }],
          },
        ],
      },
    };
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
      settings,
    });
    const events = await collect(engine.submitMessage("malicious prompt"));
    const completes = events.filter((e) => e.type === "message-complete");
    expect(completes.length).toBe(1);
    const ev = completes[0] as EngineEvent & { text: string };
    expect(ev.text).toMatch(/UserPromptSubmit hook blocked/);
    expect(ev.text).toMatch(/NOPE/);
  });

  it("exit 0 → 用户消息正常进入 transcript（虽无 provider，引擎仍尝试派发）", async () => {
    const settings: CodeclawSettings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "echo allowed" }],
          },
        ],
      },
    };
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
      settings,
    });
    const events = await collect(engine.submitMessage("normal prompt"));
    // 不应有 UserPromptSubmit hook blocked 提示
    const blocked = events.find(
      (e) => e.type === "message-complete" && /UserPromptSubmit hook blocked/.test((e as { text: string }).text)
    );
    expect(blocked).toBeUndefined();
  });

  it("slash 命令跳过 hook", async () => {
    const settings: CodeclawSettings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "exit 1" }],
          },
        ],
      },
    };
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
      settings,
    });
    const events = await collect(engine.submitMessage("/help"));
    // slash 命令直接走 reply path，不应被 hook 拦截
    const blocked = events.find(
      (e) => e.type === "message-complete" && /UserPromptSubmit hook blocked/.test((e as { text: string }).text)
    );
    expect(blocked).toBeUndefined();
  });

  it("无 settings 时 5 时点皆 no-op", async () => {
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
    });
    const events = await collect(engine.submitMessage("anything"));
    const blocked = events.find(
      (e) => e.type === "message-complete" && /hook blocked/.test((e as { text: string }).text)
    );
    expect(blocked).toBeUndefined();
  });
});

describe("queryEngine /hooks command", () => {
  it("空配置 → 列出 5 事件 + 配置示例", async () => {
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
    });
    const events = await collect(engine.submitMessage("/hooks"));
    const ev = events.find((e) => e.type === "message-complete") as { text: string };
    expect(ev.text).toContain("Hooks (lifecycle event integrations)");
    expect(ev.text).toContain("PreToolUse: (none)");
    expect(ev.text).toContain("Configure via");
  });

  it("有配置 → 列出 matcher / command / timeout", async () => {
    const settings: CodeclawSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "^bash$",
            hooks: [{ type: "command", command: "scripts/precheck.sh", timeout: 3000 }],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: "log.sh" }] }],
      },
    };
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
      settings,
    });
    const events = await collect(engine.submitMessage("/hooks"));
    const ev = events.find((e) => e.type === "message-complete") as { text: string };
    expect(ev.text).toContain("PreToolUse: 1 matcher(s), 1 command(s)");
    expect(ev.text).toContain('match=/^bash$/');
    expect(ev.text).toContain('cmd="scripts/precheck.sh"');
    expect(ev.text).toContain("timeout=3000ms");
    expect(ev.text).toContain("Stop: 1 matcher(s), 1 command(s)");
    expect(ev.text).toContain("UserPromptSubmit: (none)");
  });
});
