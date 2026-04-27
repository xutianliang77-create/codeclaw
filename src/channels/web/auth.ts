/**
 * Web Channel · 鉴权
 *
 * 阶段 A 最小实现：Bearer token 静态校验。
 *   - token 来源优先级：env CODECLAW_WEB_TOKEN > ~/.codeclaw/web-auth.json > null
 *   - 客户端在 Authorization: Bearer <token> 头里带
 *   - timing-safe 比较防侧信道泄露
 *
 * v0.7.0 P1.5：新增文件持久化路径，支持自动生成 + 重启不丢。
 *
 * 阶段 B 会加：基于 token 派生的 wsTicket（短时一次性票据），缓解 WS/SSE
 *   subprotocol 不便携 Authorization 头的问题。
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type WebAuthSource = "env" | "file" | null;

export interface WebAuthConfig {
  /** 期望的 Bearer token；空 / undefined 表示 Web channel 禁用 */
  bearerToken: string | null;
  /** token 来源（env / file / null）；用于启动日志告知用户从哪里读到的；测试可省略 */
  source?: WebAuthSource;
  /** 文件路径（即使读 env 时也填上，便于报错指引）；测试可省略 */
  filePath?: string;
}

export interface WebAuthFile {
  token: string;
  createdAt: number;
  rotateAt: number | null;
}

/** ~/.codeclaw/web-auth.json 路径 */
export function webAuthFilePath(homeDir = homedir()): string {
  return path.join(homeDir, ".codeclaw", "web-auth.json");
}

/** 从文件读 web token；不存在 / 损坏 / 空 token 返回 null */
export function readWebAuthFile(filePath = webAuthFilePath()): WebAuthFile | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const obj = JSON.parse(raw) as Partial<WebAuthFile>;
    if (typeof obj.token !== "string" || obj.token.trim().length === 0) return null;
    return {
      token: obj.token.trim(),
      createdAt: typeof obj.createdAt === "number" ? obj.createdAt : Date.now(),
      rotateAt: typeof obj.rotateAt === "number" ? obj.rotateAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * 写入 ~/.codeclaw/web-auth.json，权限 0600。
 * 失败时仅 console.warn；调用方决定是否继续。
 */
export function writeWebAuthFile(file: WebAuthFile, filePath = webAuthFilePath()): boolean {
  const dir = path.dirname(filePath);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    // 已存在文件不会被 writeFileSync 重新设权限；显式 chmod 一次
    try {
      chmodSync(filePath, 0o600);
    } catch {
      console.warn(`[web-auth] failed to chmod 0600 on ${filePath}`);
    }
    return true;
  } catch (err) {
    console.warn(
      `[web-auth] failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

/** 生成一个新的 web token（32 hex chars / 16 bytes 随机） */
export function generateWebToken(): WebAuthFile {
  return {
    token: randomBytes(16).toString("hex"),
    createdAt: Date.now(),
    rotateAt: null,
  };
}

/** 读 + 不存在则生成并落盘。返回 token 与来源标记 */
export function ensureWebToken(filePath = webAuthFilePath()): {
  token: string;
  generated: boolean;
} {
  const existing = readWebAuthFile(filePath);
  if (existing) {
    return { token: existing.token, generated: false };
  }
  const fresh = generateWebToken();
  writeWebAuthFile(fresh, filePath);
  return { token: fresh.token, generated: true };
}

/**
 * 从 env / 文件 读 Web 鉴权配置。
 * 优先级：env CODECLAW_WEB_TOKEN > ~/.codeclaw/web-auth.json > null
 * 不会自动生成；调用方决定（启动 web 子命令时调 ensureWebToken）。
 */
export function readWebAuthConfig(env: NodeJS.ProcessEnv = process.env): WebAuthConfig {
  const fp = webAuthFilePath();
  const envTok = env.CODECLAW_WEB_TOKEN?.trim();
  if (envTok && envTok.length > 0) {
    return { bearerToken: envTok, source: "env", filePath: fp };
  }
  const file = readWebAuthFile(fp);
  if (file) {
    return { bearerToken: file.token, source: "file", filePath: fp };
  }
  return { bearerToken: null, source: null, filePath: fp };
}

/**
 * timing-safe 比较两个字符串。长度不同直接 false 但仍走 buffer 比对一致时长，
 * 避免短/长 token 时间差异泄露长度信息。
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  // timingSafeEqual 要求等长；不等长用一个全零 buf 做无意义比较再返回 false
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * 解析 Authorization 头并对比 expected token。
 * 缺头 / 非 Bearer / token 不匹配 → false。
 */
export function validateBearer(
  authHeader: string | undefined,
  expected: string | null
): boolean {
  if (!expected) return false;
  if (!authHeader) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!m) return false;
  return constantTimeEquals(m[1].trim(), expected);
}
