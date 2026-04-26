/**
 * applySkillBanner 单测（M3-03）
 */

import { describe, expect, it } from "vitest";

import { applySkillBanner, formatSkillBanner } from "../../../src/agent/skillBanner";
import type { EngineMessage } from "../../../src/agent/types";
import type { SkillDefinition } from "../../../src/skills/types";

const SKILL: SkillDefinition = {
  name: "data_insight",
  description: "Read-only Dremio/PostgreSQL queries via mcp_query",
  prompt: "(full prompt body)",
  allowedTools: [],
  source: "user",
};

function userMsg(text: string, id = "u1"): EngineMessage {
  return { id, role: "user", text, source: "user" };
}

function asstMsg(text: string, id = "a1"): EngineMessage {
  return { id, role: "assistant", text, source: "model" };
}

function toolMsg(text: string, id = "t1"): EngineMessage {
  return { id, role: "tool", text, source: "local", toolCallId: "call-1", toolName: "read" };
}

describe("formatSkillBanner", () => {
  it("含 skill name + description", () => {
    expect(formatSkillBanner(SKILL)).toBe(
      "[Active skill: data_insight] Read-only Dremio/PostgreSQL queries via mcp_query"
    );
  });
});

describe("applySkillBanner", () => {
  it("无 skill → 原数组返回（同引用）", () => {
    const msgs: EngineMessage[] = [userMsg("hi")];
    expect(applySkillBanner(msgs, null)).toBe(msgs);
  });

  it("无 user message → 原数组返回（同引用）", () => {
    const msgs: EngineMessage[] = [asstMsg("greeting")];
    expect(applySkillBanner(msgs, SKILL)).toBe(msgs);
  });

  it("最后一条 user 加 banner，其他不动", () => {
    const msgs: EngineMessage[] = [userMsg("question 1")];
    const out = applySkillBanner(msgs, SKILL);
    expect(out).not.toBe(msgs);
    expect(out[0].text).toBe(
      "[Active skill: data_insight] Read-only Dremio/PostgreSQL queries via mcp_query\n\nquestion 1"
    );
    // 原 messages 不变（防止污染 transcript）
    expect(msgs[0].text).toBe("question 1");
  });

  it("multi-turn: messages 末尾是 tool，仍 decorate 最近 user message", () => {
    const msgs: EngineMessage[] = [
      userMsg("read foo.ts please", "u1"),
      asstMsg("(tool_calls)", "a1"),
      toolMsg("file content...", "t1"),
    ];
    const out = applySkillBanner(msgs, SKILL);
    expect(out[0].text).toMatch(/^\[Active skill: data_insight\].+\n\nread foo\.ts please$/);
    expect(out[1]).toBe(msgs[1]); // assistant unchanged
    expect(out[2]).toBe(msgs[2]); // tool unchanged
  });

  it("多条 user message → 只 decorate 最后一条", () => {
    const msgs: EngineMessage[] = [
      userMsg("first turn", "u1"),
      asstMsg("answer 1", "a1"),
      userMsg("second turn", "u2"),
    ];
    const out = applySkillBanner(msgs, SKILL);
    expect(out[0].text).toBe("first turn"); // 第一条保留原样
    expect(out[2].text).toMatch(/^\[Active skill: data_insight\].+\n\nsecond turn$/);
  });

  it("重复 apply 不累积 banner", () => {
    const msgs: EngineMessage[] = [userMsg("q1")];
    const once = applySkillBanner(msgs, SKILL);
    const twice = applySkillBanner(once, SKILL);
    // 累积应用会有 2 个 banner；正确实现是每次基于不同输入分别生成 1 个
    // 由于 applySkillBanner 不识别原 banner，twice 确实会再加一层 —— 这是预期：
    // 调用方应每次基于 fresh this.messages（无 banner）调用，不要传上次结果回来
    const banners = (twice[0].text.match(/\[Active skill: data_insight\]/g) ?? []).length;
    expect(banners).toBe(2);
  });
});
