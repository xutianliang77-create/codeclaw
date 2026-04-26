import { describe, expect, it } from "vitest";
import { fuzzyMatch, scoreEntry, SLASH_COMMANDS } from "./slashCommands";

describe("fuzzyMatch", () => {
  it("空 query 命中所有", () => {
    expect(fuzzyMatch("", "/anything")).toBe(true);
  });
  it("正向命中", () => {
    expect(fuzzyMatch("rag", "/rag")).toBe(true);
    expect(fuzzyMatch("modl", "/model")).toBe(true);
    expect(fuzzyMatch("commi", "/commit")).toBe(true);
  });
  it("乱序不命中", () => {
    expect(fuzzyMatch("modle", "/model")).toBe(false);
  });
});

describe("scoreEntry", () => {
  it("name 前缀 > 包含 > summary", () => {
    const rag = SLASH_COMMANDS.find((e) => e.name === "/rag")!;
    const memory = SLASH_COMMANDS.find((e) => e.name === "/memory")!;
    expect(scoreEntry("rag", rag)).toBeGreaterThan(scoreEntry("rag", memory));
  });
});

describe("SLASH_COMMANDS 表", () => {
  it("应至少有 36 条（与 docs/SLASH_COMMANDS.md 对齐）", () => {
    expect(SLASH_COMMANDS.length).toBeGreaterThanOrEqual(36);
  });
  it("每条 name 唯一且以 / 开头", () => {
    const names = new Set<string>();
    for (const e of SLASH_COMMANDS) {
      expect(e.name.startsWith("/")).toBe(true);
      expect(names.has(e.name)).toBe(false);
      names.add(e.name);
    }
  });
});
