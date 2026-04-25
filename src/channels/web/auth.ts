/**
 * Web Channel · 鉴权
 *
 * 阶段 A 最小实现：Bearer token 静态校验。
 *   - 服务端从 env CODECLAW_WEB_TOKEN 读期望 token；不设则 Web 完全禁用
 *   - 客户端在 Authorization: Bearer <token> 头里带
 *   - timing-safe 比较防侧信道泄露
 *
 * 阶段 B 会加：基于 token 派生的 wsTicket（短时一次性票据），缓解 WS/SSE
 *   subprotocol 不便携 Authorization 头的问题。
 */

import { timingSafeEqual } from "node:crypto";

export interface WebAuthConfig {
  /** 期望的 Bearer token；空 / undefined 表示 Web channel 禁用 */
  bearerToken: string | null;
}

/** 从 env 读 Web 鉴权配置；env 未设视作禁用 */
export function readWebAuthConfig(env: NodeJS.ProcessEnv = process.env): WebAuthConfig {
  const t = env.CODECLAW_WEB_TOKEN?.trim();
  return { bearerToken: t && t.length > 0 ? t : null };
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
