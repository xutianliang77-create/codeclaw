/**
 * Project Memory store 单测（M2-02）
 *
 * 覆盖 spec §5.4 的 12 case 与 patch 后补充：
 *   - getMemoryDir 路径稳定（realpath，防 symlink/相对路径双份目录）
 *   - loadAllMemories 空目录返空
 *   - writeMemory 持久化 + frontmatter + 索引重建
 *   - removeMemory 删 + 重建索引
 *   - 8KB 上限拒绝
 *   - 200 行索引 trim 按 createdAt 升序砍最旧
 *   - 隔离：不同 cwd 拿不同 dir
 *   - clearAllMemories 返计数
 *   - sanitize name：特殊字符转下划线，空名抛错
 *   - invalid type 抛错
 *   - redactSecretsInText 脱敏 body
 *   - 缓存命中：dir mtime 没变不重 readdir
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  MAX_ENTRY_BYTES,
  MAX_INDEX_LINES,
  _clearMemoryCacheForTest,
  clearAllMemories,
  getMemoryDir,
  loadAllMemories,
  loadAllMemoriesCached,
  removeMemory,
  writeMemory,
} from "../../../src/memory/projectMemory/store";

let workspace: string;
let symlinkPath: string;
let homeBackup: string | null = null;
let tmpHome: string;

beforeEach(() => {
  // 把 HOME 指向 tmp 目录，让 getMemoryDir 不污染真 ~/.codeclaw
  tmpHome = path.join(os.tmpdir(), `pm-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  homeBackup = process.env.HOME ?? null;
  process.env.HOME = tmpHome;
  // hijack os.homedir 也指向 tmp（getMemoryDir 用 homedir，不直接读 env.HOME）
  (os as unknown as { homedir: () => string }).homedir = () => tmpHome;

  workspace = path.join(tmpHome, "ws-real");
  mkdirSync(workspace, { recursive: true });
  symlinkPath = path.join(tmpHome, "ws-link");

  _clearMemoryCacheForTest();
});

afterEach(() => {
  if (homeBackup === null) delete process.env.HOME;
  else process.env.HOME = homeBackup;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("getMemoryDir", () => {
  it("返回 ~/.codeclaw/projects/<hash>/memory（自动 mkdir）", () => {
    const dir = getMemoryDir(workspace);
    expect(dir.startsWith(path.join(tmpHome, ".codeclaw", "projects"))).toBe(true);
    expect(dir.endsWith("memory")).toBe(true);
  });

  it("symlink 与原路径产生同一 dir（spec patch N4：realpath 规范化）", () => {
    symlinkSync(workspace, symlinkPath);
    const dirReal = getMemoryDir(workspace);
    const dirLink = getMemoryDir(symlinkPath);
    expect(dirLink).toBe(dirReal);
  });

  it("末尾 / 与无 / 同 dir", () => {
    const a = getMemoryDir(workspace);
    const b = getMemoryDir(workspace + "/");
    expect(a).toBe(b);
  });

  it("不同 workspace 不同 dir", () => {
    const w2 = path.join(tmpHome, "ws-other");
    mkdirSync(w2, { recursive: true });
    expect(getMemoryDir(workspace)).not.toBe(getMemoryDir(w2));
  });
});

describe("loadAllMemories / writeMemory / removeMemory", () => {
  it("空目录返空数组", () => {
    expect(loadAllMemories(workspace)).toEqual([]);
  });

  it("write + load 往返；frontmatter / body / createdAt 完整", () => {
    const e = writeMemory(workspace, {
      name: "user_role",
      description: "user 是 ML 工程师",
      type: "user",
      body: "用户在做 LLM agent 开发",
    });
    expect(e.name).toBe("user_role");
    expect(e.type).toBe("user");
    expect(e.createdAt).toBeGreaterThan(0);
    const all = loadAllMemories(workspace);
    expect(all.length).toBe(1);
    expect(all[0].body).toContain("LLM agent");
    expect(all[0].description).toBe("user 是 ML 工程师");
  });

  it("rebuildIndex 写入 MEMORY.md，含每条 entry 的 hook 行", () => {
    writeMemory(workspace, { name: "a", description: "first", type: "user", body: "x" });
    writeMemory(workspace, { name: "b", description: "second", type: "feedback", body: "y" });
    const index = readFileSync(path.join(getMemoryDir(workspace), "MEMORY.md"), "utf8");
    expect(index).toContain("# Project Memory Index");
    expect(index).toContain("- [a](a.md) — first");
    expect(index).toContain("- [b](b.md) — second");
  });

  it("removeMemory 删文件 + 索引刷新", () => {
    writeMemory(workspace, { name: "x", description: "to-remove", type: "project", body: "z" });
    expect(loadAllMemories(workspace).length).toBe(1);
    expect(removeMemory(workspace, "x")).toBe(true);
    expect(loadAllMemories(workspace).length).toBe(0);
    expect(removeMemory(workspace, "x")).toBe(false);
  });

  it("clearAllMemories 删全部并返计数", () => {
    writeMemory(workspace, { name: "a", description: "1", type: "user", body: "1" });
    writeMemory(workspace, { name: "b", description: "2", type: "user", body: "2" });
    writeMemory(workspace, { name: "c", description: "3", type: "user", body: "3" });
    expect(clearAllMemories(workspace)).toBe(3);
    expect(loadAllMemories(workspace)).toEqual([]);
  });
});

describe("validation", () => {
  it("非法 type 抛错", () => {
    expect(() =>
      writeMemory(workspace, { name: "x", description: "x", type: "invalid" as unknown as "user", body: "" })
    ).toThrow(/invalid memory type/);
  });

  it("name sanitize 全特殊字符 → 抛错", () => {
    expect(() =>
      writeMemory(workspace, { name: "!!!@@@", description: "x", type: "user", body: "" })
    ).toThrow(/sanitizes to empty/);
  });

  it("name 含特殊字符 → 转下划线", () => {
    const e = writeMemory(workspace, { name: "my role!", description: "x", type: "user", body: "" });
    expect(e.name).toBe("my_role");
  });

  it("body > 8KB → 抛错", () => {
    const huge = "x".repeat(MAX_ENTRY_BYTES + 100);
    expect(() =>
      writeMemory(workspace, { name: "big", description: "huge", type: "user", body: huge })
    ).toThrow(/too large/);
  });
});

describe("redact secrets", () => {
  it("body 含 API key 被 redact", () => {
    const apiKey = "sk-" + "a".repeat(48); // 长得像 OpenAI api key 的字串
    const e = writeMemory(workspace, {
      name: "leak",
      description: "test",
      type: "user",
      body: `please call api with ${apiKey}`,
    });
    expect(e.body).toContain("[REDACTED:");
    expect(e.body).not.toContain(apiKey);
  });
});

describe("MEMORY.md trim by createdAt", () => {
  it("超过 200 行索引按 createdAt 升序砍最旧（spec patch N5）", async () => {
    // 写 250 条，最早的应被 trim
    for (let i = 0; i < MAX_INDEX_LINES + 50; i++) {
      writeMemory(workspace, {
        name: `entry${i.toString().padStart(4, "0")}`,
        description: `desc ${i}`,
        type: "user",
        body: `body ${i}`,
      });
      // 微小 sleep 让 createdAt 不全相同（间隔 1ms 即可）
      await new Promise((r) => setTimeout(r, 1));
    }
    const index = readFileSync(path.join(getMemoryDir(workspace), "MEMORY.md"), "utf8");
    const lines = index.split("\n");
    expect(lines.length).toBeLessThanOrEqual(MAX_INDEX_LINES + 1); // +1 末尾换行
    // 最早的几条应被砍（用 entry 文件名判，避免 "desc 1" 误匹配 "desc 199"）
    expect(index).not.toContain("entry0000");
    expect(index).not.toContain("entry0001");
    // 最新的应保留
    expect(index).toContain(`entry${(MAX_INDEX_LINES + 49).toString().padStart(4, "0")}`);
  });
});

describe("loadAllMemoriesCached", () => {
  it("mtime 没变直接返缓存（不重 readdir）", () => {
    writeMemory(workspace, { name: "a", description: "1", type: "user", body: "" });
    const first = loadAllMemoriesCached(workspace);
    const second = loadAllMemoriesCached(workspace);
    // 同一引用（缓存命中）
    expect(second).toBe(first);
  });

  it("写入后缓存失效 → 重 load", () => {
    writeMemory(workspace, { name: "a", description: "1", type: "user", body: "" });
    const first = loadAllMemoriesCached(workspace);
    expect(first.length).toBe(1);
    writeMemory(workspace, { name: "b", description: "2", type: "user", body: "" });
    const second = loadAllMemoriesCached(workspace);
    expect(second.length).toBe(2);
    expect(second).not.toBe(first); // 缓存被刷
  });
});
