/**
 * W0-04 fixture 单测 · normalize.ts
 */

import { describe, expect, it } from "vitest";
import { matchesAny, matchesSubstring, normalize } from "./normalize";

describe("normalize", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalize("  Hello   World\n")).toBe("hello world");
  });

  it("normalizes full-width digits/letters to half-width via NFKC", () => {
    // 全角 '０１２３' → '0123'；全角 'Ａ' → 'A'
    expect(normalize("０１２３ ＡＢＣ")).toBe("0123 abc");
  });

  it("handles empty and undefined-like inputs", () => {
    expect(normalize("")).toBe("");
    // @ts-expect-error: intentional runtime null
    expect(normalize(null)).toBe("");
  });
});

describe("matchesSubstring", () => {
  it("finds needle in haystack after normalization", () => {
    expect(matchesSubstring("  Hello  WORLD  ", "hello world")).toBe(true);
    expect(matchesSubstring("Hello World", "foo")).toBe(false);
  });

  it("treats empty needle as a hit (guard)", () => {
    expect(matchesSubstring("anything", "")).toBe(true);
  });

  it("is case-insensitive and tolerant to CJK width", () => {
    expect(matchesSubstring("claude-sonnet-4-6", "CLAUDE-SONNET-4-6")).toBe(true);
    expect(matchesSubstring("权限模式 default", "权限模式 DEFAULT")).toBe(true);
  });
});

describe("matchesAny", () => {
  it("returns true if any needle matches", () => {
    expect(matchesAny("权限被拒绝", ["deny", "permission", "拒绝"])).toBe(true);
  });

  it("returns false when none match", () => {
    expect(matchesAny("ok", ["deny", "permission", "拒绝"])).toBe(false);
  });

  it("empty list returns false", () => {
    expect(matchesAny("anything", [])).toBe(false);
  });
});
