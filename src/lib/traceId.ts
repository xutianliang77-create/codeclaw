/**
 * ULID 单调工厂（参见 ADR-001 / v4.2 §5.1 / W0 决策锁定 · W0-05）
 *
 * ULID 格式（Crockford Base32，共 26 字符）：
 *   - 前 10 字符 = 48-bit 毫秒时间戳
 *   - 后 16 字符 = 80-bit 随机部分
 *
 * `monotonicFactory` 在同一毫秒内递增随机段，保证词典序单调（Agent Team P2 多 Worker 并发场景必须）。
 *
 * 替换 IngressGateway 旧有的 `trace-{ms}-{rand6}` 格式（R7，v4.2 §5.1 非功能目标）。
 *
 * 术语：
 *   - `traceId`：贯穿一次用户请求端到端的 ID
 *   - `eventId`：审计链 / 事件流的单条事件 ID
 *   都是同一套 ULID 编码；分开函数只为语义清晰，便于审计检索区分。
 */

import { monotonicFactory, decodeTime } from "ulid";

// ulid 本体不是纯函数；monotonicFactory 保持"同毫秒递增"内部状态
const ulid = monotonicFactory();

/** 生成贯穿一次请求的 traceId（ULID，26 字符） */
export function createTraceId(): string {
  return ulid();
}

/** 审计 / 事件流单条事件 ID（与 traceId 同一套编码） */
export function createEventId(): string {
  return ulid();
}

/** 解码 ULID 的时间戳（毫秒）；无效输入抛错 */
export function parseUlidTimestamp(id: string): number {
  return decodeTime(id);
}

/** 宽松的 ULID 格式校验（26 字符，Crockford Base32 字母表，不含 I/L/O/U） */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidUlid(id: string): boolean {
  return typeof id === "string" && ULID_RE.test(id);
}
