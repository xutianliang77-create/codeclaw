/**
 * LLM-judge · #68 单测
 *   - parseJudgeReply 容错
 *   - buildJudgePrompt 含必要字段
 *   - MockLlmJudge 行为
 *   - scorer.scoreWithJudge：judge 抛错 / 返回 unparseable → 降级字符串
 */

import { describe, expect, it, vi } from "vitest";
import {
  parseJudgeReply,
  buildJudgePrompt,
  MockLlmJudge,
  type LlmJudge,
} from "./llm-judge";
import { scoreWithJudge } from "./scorer";
import type { AskQuestion } from "./types";

function buildQ(partial: Partial<AskQuestion> = {}): AskQuestion {
  return {
    id: "ASK-T01",
    version: 1,
    category: "code-understanding",
    difficulty: "easy",
    requires: {},
    prompt: "What is 2+2?",
    expected: {
      must_mention: ["four", "4"],
      must_not_mention: ["five"],
    },
    ...partial,
  } as AskQuestion;
}

describe("parseJudgeReply", () => {
  it("规范 JSON → 提取 pass + reason", () => {
    const v = parseJudgeReply('{"pass": true, "reason": "got it"}');
    expect(v.pass).toBe(true);
    expect(v.reason).toBe("got it");
  });

  it("回复中含前后噪声 → 仍能抓 JSON 段", () => {
    const v = parseJudgeReply('Here is my verdict: {"pass": false, "reason": "missed key"} done.');
    expect(v.pass).toBe(false);
    expect(v.reason).toBe("missed key");
  });

  it("非法 JSON → pass=false 且 reason 含 snippet", () => {
    const v = parseJudgeReply("I think the answer is wrong but cannot output JSON.");
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/judge:.*snippet/);
  });

  it("空回复 → pass=false", () => {
    expect(parseJudgeReply("").pass).toBe(false);
    expect(parseJudgeReply("   ").pass).toBe(false);
  });

  it("confidence 字段被解析", () => {
    const v = parseJudgeReply('{"pass": true, "reason": "ok", "confidence": 0.85}');
    expect(v.confidence).toBe(0.85);
  });
});

describe("buildJudgePrompt", () => {
  it("含 question / answer / must_mention / forbidden / rubric", () => {
    const q = buildQ({
      expected: {
        must_mention: ["alpha", "beta"],
        must_not_mention: ["gamma"],
        rubric: "Be concise.",
      },
    });
    const p = buildJudgePrompt(q, "the answer is alpha");
    expect(p).toContain("# Question");
    expect(p).toContain(q.prompt);
    expect(p).toContain("the answer is alpha");
    expect(p).toContain("alpha");
    expect(p).toContain("beta");
    expect(p).toContain("gamma");
    expect(p).toContain("Be concise");
    expect(p).toContain('{"pass":');
  });

  it("空 answer → (empty)", () => {
    const p = buildJudgePrompt(buildQ(), "");
    expect(p).toContain("(empty)");
  });
});

describe("MockLlmJudge", () => {
  it("含 must_mention 任一 → pass=true", async () => {
    const judge = new MockLlmJudge();
    const v = await judge.evaluate({ question: buildQ(), answer: "the answer is four (4)" });
    expect(v.pass).toBe(true);
  });

  it("无 must_mention 命中 → pass=false", async () => {
    const judge = new MockLlmJudge();
    const v = await judge.evaluate({ question: buildQ(), answer: "I don't know" });
    expect(v.pass).toBe(false);
  });

  it("refusal 类（无 must_mention）+ forbidden 未命中 → pass=true", async () => {
    const q = buildQ({
      category: "refusal",
      expected: { must_not_mention: ["how to hack"] },
    });
    const judge = new MockLlmJudge();
    const v = await judge.evaluate({
      question: q,
      answer: "I cannot help with that request.",
    });
    expect(v.pass).toBe(true);
  });
});

describe("scoreWithJudge · 降级路径", () => {
  it("judge 抛错 + fallbackOnError=true → 降级字符串 scorer", async () => {
    const judge: LlmJudge = {
      evaluate: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const r = await scoreWithJudge(
      buildQ(),
      "the answer is four (4)",
      judge,
      true
    );
    expect(r.reason).toContain("[fallback string");
    expect(r.pass).toBe(true); // 字符串 scorer 命中 four / 4
  });

  it("judge 抛错 + fallbackOnError=false → 抛错向上", async () => {
    const judge: LlmJudge = {
      evaluate: vi.fn().mockRejectedValue(new Error("network down")),
    };
    await expect(
      scoreWithJudge(buildQ(), "anything", judge, false)
    ).rejects.toThrow("network down");
  });

  it("judge 返回 unparseable（reason 以 'judge:' 开头）→ 降级字符串", async () => {
    const judge: LlmJudge = {
      evaluate: vi.fn().mockResolvedValue({
        pass: false,
        reason: "judge: unparseable reply",
      }),
    };
    const r = await scoreWithJudge(buildQ(), "the answer is four (4)", judge, true);
    expect(r.reason).toContain("[fallback string");
    expect(r.pass).toBe(true);
  });

  it("judge 正常返回 pass=true → ScoreResult 标 [llm-judge] 前缀", async () => {
    const judge: LlmJudge = {
      evaluate: vi.fn().mockResolvedValue({ pass: true, reason: "covered well" }),
    };
    const r = await scoreWithJudge(buildQ(), "blah", judge);
    expect(r.pass).toBe(true);
    expect(r.reason).toBe("[llm-judge] covered well");
    expect(r.matched).toEqual(["judge:pass"]);
  });

  it("judge 正常返回 pass=false → score=0 且 missed=[judge:fail]", async () => {
    const judge: LlmJudge = {
      evaluate: vi.fn().mockResolvedValue({ pass: false, reason: "off topic" }),
    };
    const r = await scoreWithJudge(buildQ(), "blah", judge);
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0);
    expect(r.missed).toEqual(["judge:fail"]);
  });
});
