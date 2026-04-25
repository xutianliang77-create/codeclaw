/**
 * /forget 参数解析单测
 */

import { describe, expect, it } from "vitest";
import { parseForgetArgs } from "../../../src/commands/slash/builtins/forget";

describe("parseForgetArgs", () => {
  it("--all → { all: true }", () => {
    expect(parseForgetArgs("--all")).toEqual({ all: true });
  });

  it("--session <id> → { sessionId }", () => {
    expect(parseForgetArgs("--session sess-abc")).toEqual({ sessionId: "sess-abc" });
  });

  it("--since <ms> → { since: number }", () => {
    expect(parseForgetArgs("--since 1700000000000")).toEqual({ since: 1700000000000 });
  });

  it("空字符串 → null", () => {
    expect(parseForgetArgs("")).toBeNull();
    expect(parseForgetArgs("   ")).toBeNull();
  });

  it("--session 缺参数 → null", () => {
    expect(parseForgetArgs("--session")).toBeNull();
  });

  it("--since 非法数字 → null", () => {
    expect(parseForgetArgs("--since abc")).toBeNull();
    expect(parseForgetArgs("--since -1")).toBeNull();
  });

  it("未知 flag → null", () => {
    expect(parseForgetArgs("--magic")).toBeNull();
  });

  it("多余空白容忍", () => {
    expect(parseForgetArgs("  --all  ")).toEqual({ all: true });
    expect(parseForgetArgs("--session   abc")).toEqual({ sessionId: "abc" });
  });
});
