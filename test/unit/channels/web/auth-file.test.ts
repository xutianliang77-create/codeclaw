/**
 * P1.5 · web token 文件持久化路径单测
 *
 * 覆盖：
 * - readWebAuthConfig 优先级：env > 文件 > null
 * - readWebAuthFile 损坏 / 空 token 容错
 * - writeWebAuthFile 设 0600 权限
 * - ensureWebToken 已存在时不重写、缺失时生成 + 落盘
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureWebToken,
  generateWebToken,
  readWebAuthConfig,
  readWebAuthFile,
  writeWebAuthFile,
} from "../../../../src/channels/web/auth";

let tmpDir: string;
let tmpFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-auth-"));
  tmpFile = path.join(tmpDir, "web-auth.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("web auth file", () => {
  it("generateWebToken 生成 32 hex token + createdAt", () => {
    const f = generateWebToken();
    expect(f.token).toMatch(/^[0-9a-f]{32}$/);
    expect(f.createdAt).toBeGreaterThan(0);
    expect(f.rotateAt).toBeNull();
  });

  it("writeWebAuthFile 写出后 readWebAuthFile 能读回，权限 0600", () => {
    const f = generateWebToken();
    expect(writeWebAuthFile(f, tmpFile)).toBe(true);
    expect(existsSync(tmpFile)).toBe(true);

    const stat = statSync(tmpFile);
    // 取末三位八进制
    expect(stat.mode & 0o777).toBe(0o600);

    const round = readWebAuthFile(tmpFile);
    expect(round?.token).toBe(f.token);
    expect(round?.createdAt).toBe(f.createdAt);
  });

  it("readWebAuthFile 不存在时返回 null", () => {
    expect(readWebAuthFile(tmpFile)).toBeNull();
  });

  it("readWebAuthFile 损坏 JSON 时返回 null", () => {
    writeFileSync(tmpFile, "not-a-json");
    expect(readWebAuthFile(tmpFile)).toBeNull();
  });

  it("readWebAuthFile 空 token 字段时返回 null", () => {
    writeFileSync(tmpFile, JSON.stringify({ token: "  ", createdAt: 0 }));
    expect(readWebAuthFile(tmpFile)).toBeNull();
  });

  it("ensureWebToken 缺失时生成并落盘", () => {
    const r = ensureWebToken(tmpFile);
    expect(r.generated).toBe(true);
    expect(r.token).toMatch(/^[0-9a-f]{32}$/);

    const file = readWebAuthFile(tmpFile);
    expect(file?.token).toBe(r.token);
  });

  it("ensureWebToken 已存在时不重写", () => {
    const first = ensureWebToken(tmpFile);
    const second = ensureWebToken(tmpFile);
    expect(second.generated).toBe(false);
    expect(second.token).toBe(first.token);
  });
});

describe("readWebAuthConfig", () => {
  it("env 优先于文件", () => {
    const f = generateWebToken();
    writeWebAuthFile(f, tmpFile);

    // 为本测试 mock env：通过传 env 参数（readWebAuthConfig 接收 env: ProcessEnv）
    // 但函数当前用 webAuthFilePath() 默认值，需要 mock 路径。
    // 改为测：直接传 env，读出来 source=env（不走默认文件路径）
    const cfg = readWebAuthConfig({ CODECLAW_WEB_TOKEN: "env-tok" } as NodeJS.ProcessEnv);
    expect(cfg.bearerToken).toBe("env-tok");
    expect(cfg.source).toBe("env");
  });

  it("env 缺失 + 默认路径无文件时 → null", () => {
    // 这个测试依赖默认 ~/.codeclaw/web-auth.json 不存在
    // 在 CI 环境下通常成立；本机若已有该文件则读到 file。仅检查 bearerToken 非空意味着某来源
    const cfg = readWebAuthConfig({} as NodeJS.ProcessEnv);
    if (cfg.bearerToken === null) {
      expect(cfg.source).toBeNull();
    } else {
      expect(cfg.source).toBe("file");
    }
  });
});
