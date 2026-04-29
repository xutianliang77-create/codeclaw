/**
 * Dremio scorer 单测 · 双维度（must_mention + tool_calls）
 */

import { describe, expect, it } from "vitest";
import { scoreDremio } from "./dremio-scorer";
import type { DremioQuestion } from "./dremio-types";

function makeQ(partial: Partial<DremioQuestion>): DremioQuestion {
  return {
    id: "DRM-TEST",
    version: 1,
    layer: "L2",
    prompt: "test prompt",
    expected: {},
    ...partial,
  };
}

describe("scoreDremio", () => {
  it("[1] must_mention 全命中 + 无 tool_calls 维度 → pass", () => {
    const q = makeQ({ expected: { must_mention: ["alice", "bob"] } });
    const r = scoreDremio(q, "rows: alice, bob, carol", []);
    expect(r.pass).toBe(true);
    expect(r.matched).toHaveLength(2);
  });

  it("[2] must_mention 缺一（80% 阈值）→ pass", () => {
    const q = makeQ({ expected: { must_mention: ["alpha", "beta", "gamma", "delta", "epsilon"] } });
    const r = scoreDremio(q, "alpha beta gamma delta only", []);
    expect(r.pass).toBe(true);
    expect(r.missed).toEqual(["epsilon"]);
  });

  it("[3] must_mention 缺两（< 80%）→ fail", () => {
    const q = makeQ({ expected: { must_mention: ["alpha", "beta", "gamma", "delta", "epsilon"] } });
    const r = scoreDremio(q, "alpha beta only", []);
    expect(r.pass).toBe(false);
  });

  it("[4] must_not_mention 命中 → fail（即使 mention 全过）", () => {
    const q = makeQ({
      expected: { must_mention: ["alice"], must_not_mention: ["secret_token"] },
    });
    const r = scoreDremio(q, "alice with secret_token leaked", []);
    expect(r.pass).toBe(false);
    expect(r.triggered).toEqual(["secret_token"]);
  });

  it("[5] tool_calls.must_invoke 命中 → pass", () => {
    const q = makeQ({
      expected: {
        must_mention: ["alice"],
        tool_calls: { must_invoke: ["RunSqlQuery"] },
      },
    });
    const r = scoreDremio(q, "alice", ["mcp__dremio__RunSqlQuery"]);
    expect(r.pass).toBe(true);
    expect(r.invokedOk).toEqual(["RunSqlQuery"]);
    expect(r.invokedMissing).toEqual([]);
  });

  it("[6] tool_calls.must_invoke 缺失 → fail", () => {
    const q = makeQ({
      expected: {
        must_mention: ["alice"],
        tool_calls: { must_invoke: ["RunSqlQuery"] },
      },
    });
    const r = scoreDremio(q, "alice 心算的答案", ["read", "glob"]);
    expect(r.pass).toBe(false);
    expect(r.invokedMissing).toEqual(["RunSqlQuery"]);
  });

  it("[7] tool_calls.must_invoke 多选一（'A 或 B'）", () => {
    const q = makeQ({
      expected: {
        must_mention: ["x"],
        tool_calls: { must_invoke: ["GetSchemaOfTable 或 RunSqlQuery"] },
      },
    });
    const rA = scoreDremio(q, "x", ["mcp__dremio__GetSchemaOfTable"]);
    const rB = scoreDremio(q, "x", ["mcp__dremio__RunSqlQuery"]);
    expect(rA.pass).toBe(true);
    expect(rB.pass).toBe(true);
  });

  it("[8] tool_calls.must_not_invoke 命中 → fail", () => {
    const q = makeQ({
      expected: {
        must_mention: ["x"],
        tool_calls: {
          must_invoke: ["RunSqlQuery"],
          must_not_invoke: ["bash"],
        },
      },
    });
    const r = scoreDremio(q, "x", ["mcp__dremio__RunSqlQuery", "bash"]);
    expect(r.pass).toBe(false);
    expect(r.invokedForbidden).toEqual(["bash"]);
  });

  it("[9] 无 mention 无 tool_calls → pass（极端 fixture）", () => {
    const q = makeQ({ expected: {} });
    const r = scoreDremio(q, "anything", []);
    expect(r.pass).toBe(true);
  });

  it("[10] reason 含字段统计", () => {
    const q = makeQ({
      expected: {
        must_mention: ["alice", "bob"],
        tool_calls: { must_invoke: ["RunSqlQuery"] },
      },
    });
    const r = scoreDremio(q, "alice bob", ["mcp__dremio__RunSqlQuery"]);
    expect(r.reason).toContain("mention=2/2");
    expect(r.reason).toContain("tool=1/1");
  });

  it("[11] 仅 tool_calls 维度（无 mention）→ pass 看工具", () => {
    const q = makeQ({
      expected: { tool_calls: { must_invoke: ["GetSchemaOfTable"] } },
    });
    const r = scoreDremio(q, "anything", ["mcp__dremio__GetSchemaOfTable"]);
    expect(r.pass).toBe(true);
  });
});
