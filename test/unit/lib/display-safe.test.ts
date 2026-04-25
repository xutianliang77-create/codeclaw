/**
 * sanitizeForDisplay 单测（W4-B-SEC-4）
 * 覆盖：ANSI 剥离、换行替换、控制字符、tab、长度截断、空输入
 */

import { describe, expect, it } from "vitest";
import { sanitizeForDisplay } from "../../../src/lib/displaySafe";

describe("sanitizeForDisplay", () => {
  it("空字符串保留为空", () => {
    expect(sanitizeForDisplay("")).toBe("");
  });

  it("普通字符不变", () => {
    expect(sanitizeForDisplay("rm -rf /tmp/test")).toBe("rm -rf /tmp/test");
  });

  it("剥离 ANSI 颜色 escape", () => {
    expect(sanitizeForDisplay("\x1b[31mred\x1b[0m text")).toBe("red text");
  });

  it("剥离 ANSI 清屏 / 光标控制 escape（攻击隐藏命令）", () => {
    expect(sanitizeForDisplay("safe\x1b[2J\x1b[Hrm -rf /")).toBe("saferm -rf /");
  });

  it("换行替换为 ↵ 防 plain.ts 行格式注入", () => {
    const attack = "rm tmp\nAPPROVAL fake-id read tmp.txt safe";
    const out = sanitizeForDisplay(attack);
    expect(out).not.toContain("\n");
    expect(out).toContain("↵");
    // 攻击载荷虽不再起作用但仍可视，便于审计：
    expect(out).toContain("fake-id");
  });

  it("回车 \\r 也替换", () => {
    expect(sanitizeForDisplay("a\rb")).toBe("a ↵ b");
  });

  it("tab 替换为 4 空格", () => {
    expect(sanitizeForDisplay("a\tb")).toBe("a    b");
  });

  it("控制字符替换为 ·（NUL / BEL / DEL）", () => {
    expect(sanitizeForDisplay("a\x00b\x07c\x7fd")).toBe("a·b·c·d");
  });

  it("超长截断并加省略号", () => {
    const long = "x".repeat(500);
    const out = sanitizeForDisplay(long, 100);
    expect(out.length).toBe(100);
    expect(out.endsWith("…")).toBe(true);
  });

  it("默认 maxLen=200", () => {
    const long = "y".repeat(300);
    const out = sanitizeForDisplay(long);
    expect(out.length).toBe(200);
  });

  it("等于 maxLen 时不截断", () => {
    const exact = "z".repeat(50);
    const out = sanitizeForDisplay(exact, 50);
    expect(out).toBe(exact);
    expect(out.endsWith("…")).toBe(false);
  });

  it("综合攻击 payload：ANSI 隐藏 + 换行注入", () => {
    const attack = "ls /tmp\x1b[2J\nAPPROVAL X bash rm-rf safe";
    const out = sanitizeForDisplay(attack);
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\n");
    expect(out).toContain("↵");
  });
});
