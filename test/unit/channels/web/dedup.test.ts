/**
 * Web Channel · ingress dedup 接入单测
 *
 * 直接调 handleMessage()；mock req/res + SessionStore，注入真实 dedupDb。
 * 覆盖：
 *   - 不传 clientId → 不走 dedup（向后兼容）
 *   - 同 clientId 二次提交 → 202 + deduplicated:true 短路（runSubmit 仅调 1 次）
 *   - 不同 clientId → 不去重（runSubmit 调 2 次）
 *   - dedupDb 未注入 + 传 clientId → 不去重（向后兼容）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";

import { handleMessage } from "../../../../src/channels/web/handlers";
import type { HandlerDeps } from "../../../../src/channels/web/handlers";
import { openDataDb } from "../../../../src/storage/db";

const TOKEN = "tok-aaaa1111";
const tempDirs: string[] = [];
let dedupDb: Database.Database;

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-web-dedup-"));
  tempDirs.push(dir);
  dedupDb = openDataDb({ path: path.join(dir, "data.db"), singleton: false }).db;
});

afterEach(() => {
  try { dedupDb.close(); } catch { /* ignore */ }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

interface MockReq {
  headers: { authorization?: string };
  on(ev: string, cb: (...a: unknown[]) => void): MockReq;
  destroy?(): void;
}

function buildReq(body: unknown): MockReq {
  const buf = Buffer.from(JSON.stringify(body));
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const req: MockReq = {
    headers: { authorization: `Bearer ${TOKEN}` },
    on(ev, cb) {
      (listeners[ev] ??= []).push(cb);
      // 立刻同步派发 data + end
      if (ev === "data") {
        queueMicrotask(() => {
          cb(buf);
          listeners["end"]?.forEach((c) => c());
        });
      }
      return req;
    },
  };
  return req;
}

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body?: string;
  setHeader(k: string, v: string): void;
  end(b?: string): void;
}

function buildRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { if (b !== undefined) this.body = b; },
  };
}

function buildDeps(opts: { withDedup: boolean; runSubmit: ReturnType<typeof vi.fn> }): HandlerDeps {
  return {
    store: {
      get: () => ({
        meta: { sessionId: "s1", userId: `web-${TOKEN.slice(0, 8)}`, channel: "http", createdAt: 0, lastSeenAt: 0 },
        engine: {} as never,
        emitter: new EventEmitter(),
      }),
      runSubmit: opts.runSubmit,
    } as unknown as HandlerDeps["store"],
    auth: { bearerToken: TOKEN },
    dataDb: opts.withDedup ? dedupDb : undefined,
  };
}

describe("Web dedup · handleMessage", () => {
  it("不传 clientId → 不走 dedup，runSubmit 被调用", async () => {
    const runSubmit = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps({ withDedup: true, runSubmit });
    const req = buildReq({ sessionId: "s1", input: "hi" });
    const res = buildRes();

    await handleMessage(req as never, res as never, deps);
    expect(res.statusCode).toBe(202);
    expect(runSubmit).toHaveBeenCalledTimes(1);
    const body = JSON.parse(res.body!) as { accepted: boolean; deduplicated?: boolean };
    expect(body.accepted).toBe(true);
    expect(body.deduplicated).toBeUndefined();
  });

  it("同 clientId 二次提交 → 202 deduplicated:true，runSubmit 只调 1 次", async () => {
    const runSubmit = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps({ withDedup: true, runSubmit });

    // 第一次：通过
    const res1 = buildRes();
    await handleMessage(
      buildReq({ sessionId: "s1", input: "hello", clientId: "c-abc" }) as never,
      res1 as never,
      deps
    );
    expect(res1.statusCode).toBe(202);
    expect(runSubmit).toHaveBeenCalledTimes(1);

    // 第二次：相同 clientId → 短路
    const res2 = buildRes();
    await handleMessage(
      buildReq({ sessionId: "s1", input: "hello", clientId: "c-abc" }) as never,
      res2 as never,
      deps
    );
    expect(res2.statusCode).toBe(202);
    const body = JSON.parse(res2.body!) as { accepted: boolean; deduplicated?: boolean; lastDelivery?: unknown };
    expect(body.deduplicated).toBe(true);
    expect(body.lastDelivery).toMatchObject({ sessionId: "s1" });
    // 关键：runSubmit 没再调
    expect(runSubmit).toHaveBeenCalledTimes(1);
  });

  it("不同 clientId → 各自处理（runSubmit 调 2 次）", async () => {
    const runSubmit = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps({ withDedup: true, runSubmit });

    await handleMessage(
      buildReq({ sessionId: "s1", input: "a", clientId: "c-1" }) as never,
      buildRes() as never,
      deps
    );
    await handleMessage(
      buildReq({ sessionId: "s1", input: "b", clientId: "c-2" }) as never,
      buildRes() as never,
      deps
    );
    expect(runSubmit).toHaveBeenCalledTimes(2);
  });

  it("dedupDb 未注入 + 传 clientId → 仍正常处理（向后兼容）", async () => {
    const runSubmit = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps({ withDedup: false, runSubmit });

    await handleMessage(
      buildReq({ sessionId: "s1", input: "x", clientId: "c-x" }) as never,
      buildRes() as never,
      deps
    );
    await handleMessage(
      buildReq({ sessionId: "s1", input: "y", clientId: "c-x" }) as never,
      buildRes() as never,
      deps
    );
    // 没 db 谈不上去重
    expect(runSubmit).toHaveBeenCalledTimes(2);
  });
});
