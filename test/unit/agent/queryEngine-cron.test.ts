/**
 * QueryEngine · #116 Cron 集成
 *
 * 在 vitest 环境下 cronManager 默认禁用；用 env CODECLAW_CRON 显式启动 + tmpdir 路径
 * 覆盖 /cron 命令分发与通知注入。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createQueryEngine } from "../../../src/agent/queryEngine";
import type { EngineEvent } from "../../../src/agent/types";

let tmpHome: string;
let originalHome: string | undefined;
let originalCron: string | undefined;
let originalVitest: string | undefined;

beforeEach(() => {
  tmpHome = path.join(
    os.tmpdir(),
    `cron-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tmpHome, { recursive: true });
  // 改 HOME 让 defaultCronPaths 落入临时目录
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  originalCron = process.env.CODECLAW_CRON;
  originalVitest = process.env.VITEST;
  // 暂时关闭 VITEST 让 queryEngine 启用 cron
  delete process.env.VITEST;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCron === undefined) delete process.env.CODECLAW_CRON;
  else process.env.CODECLAW_CRON = originalCron;
  if (originalVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = originalVitest;
  rmSync(tmpHome, { recursive: true, force: true });
});

async function collect(gen: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

function lastReply(events: EngineEvent[]): string {
  const completes = events.filter((e) => e.type === "message-complete");
  return (completes[completes.length - 1] as { text: string }).text;
}

describe("queryEngine /cron 集成", () => {
  it("/cron 空 → list 提示无任务", async () => {
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
    });
    const events = await collect(engine.submitMessage("/cron"));
    expect(lastReply(events)).toContain("no tasks");
    (engine as unknown as { disposeCron: () => void }).disposeCron();
  });

  it("/cron add → list 出现任务，落盘到 cron.json", async () => {
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
    });
    await collect(
      engine.submitMessage('/cron add my-job "@daily" slash:/foo --notify=cli')
    );
    const list = await collect(engine.submitMessage("/cron list"));
    expect(lastReply(list)).toContain("my-job");
    // 文件存在
    expect(existsSync(path.join(tmpHome, ".codeclaw", "cron.json"))).toBe(true);
    (engine as unknown as { disposeCron: () => void }).disposeCron();
  });

  it("CODECLAW_CRON=false → 提示禁用", async () => {
    process.env.CODECLAW_CRON = "false";
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
    });
    const events = await collect(engine.submitMessage("/cron"));
    expect(lastReply(events)).toContain("cron is disabled");
    (engine as unknown as { disposeCron: () => void }).disposeCron();
  });

  it("disposeCron 是 idempotent", async () => {
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
    });
    const e = engine as unknown as { disposeCron: () => void; getCronManager: () => unknown };
    expect(e.getCronManager()).not.toBe(null);
    e.disposeCron();
    expect(e.getCronManager()).toBe(null);
    e.disposeCron(); // 再调一次不抛
  });
});
