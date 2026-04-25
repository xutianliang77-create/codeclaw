/**
 * Web Channel · Server-side session 状态
 *
 * 把 QueryEngine 实例 + 待派发事件 emitter 装在一起。
 * POST /messages 进来异步驱动 submitMessage()；GET /stream（SSE）监听 emitter
 * 把每个 EngineEvent 当 SSE 帧推给客户端。
 *
 * 设计：
 *   - 单 sessionId 单 QueryEngine 实例（in-memory Map）
 *   - 同 sessionId 多次 stream 连接 → 都监听同一 emitter（broadcast）
 *   - destroy 时移除实例并 emit 'close' 让所有 SSE 客户端关闭
 *   - vitest 环境下 dataDb 仍由 QueryEngine 自己处理（不在此层管）
 */

import { EventEmitter } from "node:events";
import { ulid } from "ulid";

import type { EngineEvent, QueryEngine, QueryEngineOptions } from "../../agent/types";

export interface ServerSessionMeta {
  sessionId: string;
  userId: string;
  channel: "http";
  createdAt: number;
  lastSeenAt: number;
}

interface InternalServerSession {
  meta: ServerSessionMeta;
  engine: QueryEngine;
  emitter: EventEmitter;
}

export type EngineFactory = (options: QueryEngineOptions) => QueryEngine;

export interface SessionStoreOptions {
  /** QueryEngine 工厂；测试可注入 mock */
  engineFactory: EngineFactory;
  /** QueryEngine 默认参数（每次 createSession 用此基础 + per-call 覆盖）*/
  engineDefaults: Omit<QueryEngineOptions, "channel" | "userId">;
}

export class SessionStore {
  private readonly map = new Map<string, InternalServerSession>();
  private readonly opts: SessionStoreOptions;

  constructor(opts: SessionStoreOptions) {
    this.opts = opts;
  }

  /** 新建 session 实例。userId 来自鉴权层；sessionId 由内部 ULID 生成。*/
  create(userId: string): ServerSessionMeta {
    const sessionId = `web-${ulid()}`;
    const engine = this.opts.engineFactory({
      ...this.opts.engineDefaults,
      channel: "http",
      userId,
    });
    const meta: ServerSessionMeta = {
      sessionId,
      userId,
      channel: "http",
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.map.set(sessionId, {
      meta,
      engine,
      emitter: new EventEmitter(),
    });
    return meta;
  }

  /** 拿 session（含 emitter）；不存在或 userId 不匹配返回 null（隔离） */
  get(sessionId: string, userId: string): InternalServerSession | null {
    const s = this.map.get(sessionId);
    if (!s) return null;
    if (s.meta.userId !== userId) return null;
    s.meta.lastSeenAt = Date.now();
    return s;
  }

  list(userId: string): ServerSessionMeta[] {
    return [...this.map.values()]
      .filter((s) => s.meta.userId === userId)
      .map((s) => s.meta);
  }

  destroy(sessionId: string, userId: string): boolean {
    const s = this.get(sessionId, userId);
    if (!s) return false;
    s.emitter.emit("close");
    s.emitter.removeAllListeners();
    this.map.delete(sessionId);
    return true;
  }

  /**
   * 异步驱动 engine.submitMessage 把 events 喂给 emitter；不抛任何异常。
   * 调用方（POST /messages handler）通常 fire-and-forget 这个 promise。
   */
  async runSubmit(sessionId: string, userId: string, input: string): Promise<void> {
    const s = this.get(sessionId, userId);
    if (!s) return;
    try {
      for await (const ev of s.engine.submitMessage(input)) {
        s.emitter.emit("event", ev satisfies EngineEvent);
      }
    } catch (err) {
      // submitMessage 内部异常时给前端一条可见的错误消息
      s.emitter.emit("event", {
        type: "message-complete",
        messageId: `err-${Date.now()}`,
        text: `[server error] ${err instanceof Error ? err.message : String(err)}`,
      } satisfies EngineEvent);
    }
  }

  size(): number {
    return this.map.size;
  }
}
