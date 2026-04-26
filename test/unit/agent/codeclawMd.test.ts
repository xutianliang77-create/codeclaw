/**
 * CODECLAW.md 加载单测（M1-A.5）
 *
 * 覆盖：
 *   - 文件存在 → 返回 trim 后内容
 *   - 文件不存在 → null
 *   - 空白文件 → null
 *   - >64KB → null + stderr warning
 *   - 路径是目录 → null
 *   - 用户级 / 项目级 路径分别命中
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  MAX_CODECLAW_MD_BYTES,
  appendProjectCodeclawMd,
  appendUserCodeclawMd,
  loadProjectCodeclawMd,
  loadUserCodeclawMd,
} from "../../../src/agent/codeclawMd";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = path.join(os.tmpdir(), `codeclaw-md-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadProjectCodeclawMd", () => {
  it("文件存在 → 返回 trim 后内容", () => {
    writeFileSync(path.join(tmpRoot, "CODECLAW.md"), "  use pnpm\n  中文回答  \n");
    expect(loadProjectCodeclawMd(tmpRoot)).toBe("use pnpm\n  中文回答");
  });

  it("文件不存在 → null", () => {
    expect(loadProjectCodeclawMd(tmpRoot)).toBeNull();
  });

  it("空白文件 → null", () => {
    writeFileSync(path.join(tmpRoot, "CODECLAW.md"), "   \n  \n");
    expect(loadProjectCodeclawMd(tmpRoot)).toBeNull();
  });

  it("> 64KB 跳过并 stderr warn", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const big = "x".repeat(MAX_CODECLAW_MD_BYTES + 100);
    writeFileSync(path.join(tmpRoot, "CODECLAW.md"), big);
    expect(loadProjectCodeclawMd(tmpRoot)).toBeNull();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("CODECLAW.md"));
    stderr.mockRestore();
  });

  it("路径是目录 → null（不是文件）", () => {
    mkdirSync(path.join(tmpRoot, "CODECLAW.md"));
    expect(loadProjectCodeclawMd(tmpRoot)).toBeNull();
  });
});

describe("loadUserCodeclawMd", () => {
  it("从 homeDir/.codeclaw/CODECLAW.md 读取", () => {
    mkdirSync(path.join(tmpRoot, ".codeclaw"), { recursive: true });
    writeFileSync(path.join(tmpRoot, ".codeclaw", "CODECLAW.md"), "回答用中文");
    expect(loadUserCodeclawMd(tmpRoot)).toBe("回答用中文");
  });

  it("homeDir 中无 .codeclaw 目录 → null", () => {
    expect(loadUserCodeclawMd(tmpRoot)).toBeNull();
  });
});

describe("appendProjectCodeclawMd", () => {
  it("初次写：自动加 header + bullet", () => {
    const r = appendProjectCodeclawMd(tmpRoot, "use pnpm");
    expect(r.appended).toBe("- use pnpm");
    const txt = loadProjectCodeclawMd(tmpRoot)!;
    expect(txt).toContain("# CodeClaw Preferences");
    expect(txt).toContain("- use pnpm");
  });

  it("已有内容追加新 bullet", () => {
    appendProjectCodeclawMd(tmpRoot, "use pnpm");
    appendProjectCodeclawMd(tmpRoot, "回答用中文");
    const txt = loadProjectCodeclawMd(tmpRoot)!;
    expect(txt).toContain("- use pnpm");
    expect(txt).toContain("- 回答用中文");
  });

  it("用户已带 - 前缀不重复加", () => {
    const r = appendProjectCodeclawMd(tmpRoot, "- already prefixed");
    expect(r.appended).toBe("- already prefixed");
  });

  it("用户带 * 前缀也不重复加", () => {
    const r = appendProjectCodeclawMd(tmpRoot, "* star prefixed");
    expect(r.appended).toBe("* star prefixed");
  });

  it("空字符串抛错", () => {
    expect(() => appendProjectCodeclawMd(tmpRoot, "")).toThrow(/must not be empty/);
    expect(() => appendProjectCodeclawMd(tmpRoot, "   ")).toThrow(/must not be empty/);
  });

  it("超 64KB 抛错", () => {
    appendProjectCodeclawMd(tmpRoot, "first");
    const huge = "x".repeat(MAX_CODECLAW_MD_BYTES);
    expect(() => appendProjectCodeclawMd(tmpRoot, huge)).toThrow(/exceed/);
  });
});

describe("appendUserCodeclawMd", () => {
  it("自动创建 ~/.codeclaw 目录 + 文件", () => {
    const home = path.join(tmpRoot, "no-codeclaw-yet");
    mkdirSync(home, { recursive: true });
    const r = appendUserCodeclawMd("中文回答", home);
    expect(r.path.endsWith(".codeclaw/CODECLAW.md")).toBe(true);
    expect(r.appended).toBe("- 中文回答");
    expect(loadUserCodeclawMd(home)).toContain("- 中文回答");
  });
});
