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
