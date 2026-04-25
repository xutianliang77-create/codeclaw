/**
 * /fix v3 · diff_scope 校验单测
 *
 * 覆盖 parseDiffStatSummary 与 evaluateDiffScope 的边界：
 *   - 单/多文件 summary 行
 *   - 纯 insertions / 纯 deletions
 *   - 空 stdout / 非 git 输出
 *   - 阈值临界（=、>）
 *   - opts 覆盖默认阈值
 */

import { describe, expect, it } from "vitest";

import {
  DIFF_SCOPE_MAX_FILES,
  DIFF_SCOPE_MAX_LINES,
  evaluateDiffScope,
  parseDiffStatSummary,
} from "../../../src/agent/queryEngine";

describe("parseDiffStatSummary", () => {
  it("解析多文件 summary（含插入与删除）", () => {
    const stat = [
      " src/foo.ts | 10 +++++-----",
      " src/bar.ts |  5 +----",
      " 2 files changed, 8 insertions(+), 7 deletions(-)",
    ].join("\n");
    expect(parseDiffStatSummary(stat)).toEqual({
      files: 2,
      insertions: 8,
      deletions: 7,
    });
  });

  it("解析单文件 summary（'1 file changed'）", () => {
    const stat = " src/foo.ts | 3 +++\n 1 file changed, 3 insertions(+)";
    expect(parseDiffStatSummary(stat)).toEqual({
      files: 1,
      insertions: 3,
      deletions: 0,
    });
  });

  it("纯 deletions（无 insertions 段）", () => {
    const stat = " 1 file changed, 4 deletions(-)";
    expect(parseDiffStatSummary(stat)).toEqual({
      files: 1,
      insertions: 0,
      deletions: 4,
    });
  });

  it("空 stdout 返回 null", () => {
    expect(parseDiffStatSummary("")).toBeNull();
    expect(parseDiffStatSummary("   \n  ")).toBeNull();
  });

  it("非 git 输出（无 summary 行）返回 null", () => {
    expect(parseDiffStatSummary("fatal: not a git repository")).toBeNull();
  });
});

describe("evaluateDiffScope", () => {
  it("空 diff 视为 ok（不 abort）", () => {
    const r = evaluateDiffScope("");
    expect(r.exceeded).toBe(false);
    expect(r.files).toBe(0);
    expect(r.lines).toBe(0);
    expect(r.reason).toBeUndefined();
  });

  it("文件数与行数都在阈值内 → ok", () => {
    const stat = " 2 files changed, 50 insertions(+), 30 deletions(-)";
    const r = evaluateDiffScope(stat);
    expect(r.exceeded).toBe(false);
    expect(r.files).toBe(2);
    expect(r.lines).toBe(80);
  });

  it("等于默认阈值 → 仍 ok（边界严格大于触发）", () => {
    // files=5, lines=300 → 不超 (>= 阈值才超)
    const stat = ` ${DIFF_SCOPE_MAX_FILES} files changed, ${DIFF_SCOPE_MAX_LINES} insertions(+)`;
    const r = evaluateDiffScope(stat);
    expect(r.exceeded).toBe(false);
  });

  it("文件数超阈值 → ABORT，reason 含 max-files", () => {
    const stat = ` ${DIFF_SCOPE_MAX_FILES + 1} files changed, 10 insertions(+)`;
    const r = evaluateDiffScope(stat);
    expect(r.exceeded).toBe(true);
    expect(r.reason).toContain(`max-files=${DIFF_SCOPE_MAX_FILES}`);
    expect(r.reason).not.toContain("max-lines");
  });

  it("行数超阈值 → ABORT，reason 含 max-lines", () => {
    const stat = ` 2 files changed, ${DIFF_SCOPE_MAX_LINES + 1} insertions(+)`;
    const r = evaluateDiffScope(stat);
    expect(r.exceeded).toBe(true);
    expect(r.reason).toContain(`max-lines=${DIFF_SCOPE_MAX_LINES}`);
  });

  it("两者都超 → reason 含两个原因（用 ; 拼接）", () => {
    const stat = ` ${DIFF_SCOPE_MAX_FILES + 2} files changed, ${
      DIFF_SCOPE_MAX_LINES + 50
    } insertions(+)`;
    const r = evaluateDiffScope(stat);
    expect(r.exceeded).toBe(true);
    expect(r.reason).toContain("max-files");
    expect(r.reason).toContain("max-lines");
    expect(r.reason).toContain(";");
  });

  it("opts 可覆盖默认阈值（更严）", () => {
    const stat = " 2 files changed, 50 insertions(+)"; // 默认 ok
    const r = evaluateDiffScope(stat, { maxFiles: 1, maxLines: 1000 });
    expect(r.exceeded).toBe(true);
    expect(r.reason).toContain("max-files=1");
  });

  it("opts 可覆盖默认阈值（更宽）", () => {
    const stat = " 10 files changed, 500 insertions(+)"; // 默认 abort
    const r = evaluateDiffScope(stat, { maxFiles: 100, maxLines: 10000 });
    expect(r.exceeded).toBe(false);
  });

  it("insertions + deletions 相加判 lines", () => {
    // 200 + 200 = 400 > 300 默认 → abort
    const stat = " 2 files changed, 200 insertions(+), 200 deletions(-)";
    const r = evaluateDiffScope(stat);
    expect(r.exceeded).toBe(true);
    expect(r.lines).toBe(400);
    expect(r.reason).toContain("max-lines");
  });
});
