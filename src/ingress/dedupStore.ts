/**
 * Ingress 幂等键存储 · W4-08 / T19
 *
 * 同一 (channel, user_id, client_id) 在 ttl 内多次提交视为重复。
 * 用于：
 *   - WeChat / Web webhook 重试时不重复跑 LLM
 *   - SDK 客户端 client_id 去重（reconnect 重发）
 *
 * 设计取舍：
 *   - 直接用 ingress_dedup 表（001_init.sql 已建）
 *   - last_delivery 字段存 JSON 序列化的上次响应，让重复请求拿回相同结果
 *   - ttl_ms 默认 600_000（10 min）；超过视为新消息
 *   - purgeExpired 是手动调用（cron / 启动时一次），不在 hot path 跑
 */

import type Database from "better-sqlite3";

export interface DedupCheckResult {
  isDuplicate: boolean;
  /** 重复时返回上次记录的 delivery（已 JSON parse） */
  lastDelivery?: unknown;
}

interface DedupRow {
  client_id: string;
  channel: string;
  user_id: string;
  first_seen_at: number;
  ttl_ms: number;
  last_delivery: string | null;
}

const DEFAULT_TTL_MS = 600_000;

/**
 * 检查 client_id 是否已在 ttl 内见过；未见过则注册一条新记录。
 * 返回 isDuplicate=true 时调用方应跳过实际处理，直接复用 lastDelivery。
 */
export function checkAndRegister(
  db: Database.Database,
  args: {
    clientId: string;
    channel: string;
    userId: string;
    ttlMs?: number;
    now?: number;
  }
): DedupCheckResult {
  const now = args.now ?? Date.now();
  const ttlMs = args.ttlMs ?? DEFAULT_TTL_MS;

  const row = db
    .prepare<unknown[], DedupRow>(
      `SELECT client_id, channel, user_id, first_seen_at, ttl_ms, last_delivery
       FROM ingress_dedup
       WHERE client_id = ?`
    )
    .get(args.clientId);

  if (row) {
    // 同 channel+user 才认；不同 user 重用同 client_id 视为新（保险）
    if (row.channel === args.channel && row.user_id === args.userId) {
      const expiredAt = row.first_seen_at + row.ttl_ms;
      if (now <= expiredAt) {
        let delivery: unknown;
        if (row.last_delivery) {
          try {
            delivery = JSON.parse(row.last_delivery);
          } catch {
            delivery = undefined;
          }
        }
        return { isDuplicate: true, lastDelivery: delivery };
      }
    }
    // 过期 / 跨 user：覆盖
    db.prepare(
      `UPDATE ingress_dedup
         SET channel = ?, user_id = ?, first_seen_at = ?, ttl_ms = ?, last_delivery = NULL
       WHERE client_id = ?`
    ).run(args.channel, args.userId, now, ttlMs, args.clientId);
    return { isDuplicate: false };
  }

  db.prepare(
    `INSERT INTO ingress_dedup(client_id, channel, user_id, first_seen_at, ttl_ms, last_delivery)
     VALUES (?, ?, ?, ?, ?, NULL)`
  ).run(args.clientId, args.channel, args.userId, now, ttlMs);
  return { isDuplicate: false };
}

/**
 * 处理完成后回填 delivery，下次重复请求可拿回。
 * client_id 不存在时是 noop（不抛）。
 */
export function recordDelivery(
  db: Database.Database,
  clientId: string,
  delivery: unknown
): void {
  const json = JSON.stringify(delivery);
  db.prepare(
    `UPDATE ingress_dedup SET last_delivery = ? WHERE client_id = ?`
  ).run(json, clientId);
}

/** 清理过期记录；返回删除条数。建议启动时 + 每小时一次。*/
export function purgeExpired(db: Database.Database, now: number = Date.now()): number {
  const r = db
    .prepare(`DELETE FROM ingress_dedup WHERE first_seen_at + ttl_ms < ?`)
    .run(now);
  return r.changes;
}
