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

  // v0.8.1 #5：多级 walk-up
  describe("walk-up 多级合并", () => {
    it("子目录无 CODECLAW.md 时回退父级（仓库根）", () => {
      // 仓库根（含 .git）+ root CODECLAW.md
      mkdirSync(path.join(tmpRoot, ".git"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "CODECLAW.md"), "use pnpm");
      // 子包目录无 CODECLAW.md
      const sub = path.join(tmpRoot, "packages", "auth");
      mkdirSync(sub, { recursive: true });
      // 用 fakeHome 隔离防污染
      const fakeHome = path.join(tmpRoot, "fake-home");
      mkdirSync(fakeHome);
      expect(loadProjectCodeclawMd(sub, fakeHome)).toBe("use pnpm");
    });

    it("两级都有 → 合并加 ## level header（父级在前、子级在后）", () => {
      mkdirSync(path.join(tmpRoot, ".git"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "CODECLAW.md"), "root rule");
      const sub = path.join(tmpRoot, "packages", "auth");
      mkdirSync(sub, { recursive: true });
      writeFileSync(path.join(sub, "CODECLAW.md"), "sub rule");
      const fakeHome = path.join(tmpRoot, "fake-home");
      mkdirSync(fakeHome);
      const out = loadProjectCodeclawMd(sub, fakeHome)!;
      expect(out).toContain("## CODECLAW.md (level 1/2");
      expect(out).toContain("## CODECLAW.md (level 2/2");
      // 父级在前
      const rootIdx = out.indexOf("root rule");
      const subIdx = out.indexOf("sub rule");
      expect(rootIdx).toBeGreaterThan(-1);
      expect(subIdx).toBeGreaterThan(rootIdx);
    });

    it("walk-up 遇 .git 即停（不读 .git 上方）", () => {
      // 上层有 CODECLAW.md，但 .git 在下层 → 上层不该被读
      writeFileSync(path.join(tmpRoot, "CODECLAW.md"), "should NOT be read");
      const repo = path.join(tmpRoot, "repo");
      mkdirSync(path.join(repo, ".git"), { recursive: true });
      writeFileSync(path.join(repo, "CODECLAW.md"), "repo rule");
      const fakeHome = path.join(tmpRoot, "fake-home");
      mkdirSync(fakeHome);
      const out = loadProjectCodeclawMd(repo, fakeHome);
      expect(out).toBe("repo rule");
      expect(out).not.toContain("should NOT be read");
    });

    it("walk-up 跳过 home 目录的 CODECLAW.md（由 loadUserCodeclawMd 处理）", () => {
      const fakeHome = path.join(tmpRoot, "fake-home");
      mkdirSync(fakeHome);
      // 故意在 home 下放一个 CODECLAW.md（不在 .codeclaw 子目录）
      writeFileSync(path.join(fakeHome, "CODECLAW.md"), "home should be skipped");
      // workspace 是 home 子目录但无 .git
      const ws = path.join(fakeHome, "myproject");
      mkdirSync(ws);
      writeFileSync(path.join(ws, "CODECLAW.md"), "project rule");
      const out = loadProjectCodeclawMd(ws, fakeHome);
      expect(out).toBe("project rule");
      expect(out).not.toContain("home should be skipped");
    });
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
