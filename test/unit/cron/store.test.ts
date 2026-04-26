/**
 * cron store + 运行历史单测（#116 step C.1）
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendRunLog,
  defaultCronPaths,
  loadCronStore,
  parseCronStore,
  readRecentRuns,
  saveCronStore,
} from "../../../src/cron/store";
import type { CronRun, CronStoreShape } from "../../../src/cron/types";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = path.join(
    os.tmpdir(),
    `cron-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function paths() {
  return {
    storeFile: path.join(tmpRoot, "cron.json"),
    runsDir: path.join(tmpRoot, "cron-runs"),
  };
}

describe("parseCronStore", () => {
  it("空 / {} 都视为空 store", () => {
    expect(parseCronStore("")).toEqual({ tasks: {} });
    expect(parseCronStore("{}")).toEqual({ tasks: {} });
  });

  it("基础任务被解析", () => {
    const json = JSON.stringify({
      tasks: {
        "01H1": {
          id: "01H1",
          name: "daily-rag",
          schedule: "0 2 * * *",
          kind: "slash",
          payload: "/rag index",
          enabled: true,
          createdAt: 1700000000000,
        },
      },
    });
    const s = parseCronStore(json);
    expect(s.tasks["01H1"].name).toBe("daily-rag");
    expect(s.tasks["01H1"].kind).toBe("slash");
  });

  it("非法 kind → 抛错", () => {
    const json = JSON.stringify({
      tasks: {
        "01H1": {
          id: "01H1",
          name: "x",
          schedule: "* * * * *",
          kind: "bogus",
          payload: "/foo",
          enabled: true,
          createdAt: 1,
        },
      },
    });
    expect(() => parseCronStore(json)).toThrow();
  });

  it("非法 notifyChannel → 抛错", () => {
    const json = JSON.stringify({
      tasks: {
        x: {
          id: "x",
          name: "x",
          schedule: "* * * * *",
          kind: "slash",
          payload: "/x",
          enabled: true,
          createdAt: 1,
          notifyChannels: ["telegram"],
        },
      },
    });
    expect(() => parseCronStore(json)).toThrow();
  });

  it("缺必填 → 抛错", () => {
    const json = JSON.stringify({ tasks: { x: { id: "x" } } });
    expect(() => parseCronStore(json)).toThrow();
  });
});

describe("loadCronStore", () => {
  it("文件不存在 → 空 store", () => {
    expect(loadCronStore(paths())).toEqual({ tasks: {} });
  });

  it("文件存在 + 合法", () => {
    const p = paths();
    mkdirSync(path.dirname(p.storeFile), { recursive: true });
    writeFileSync(
      p.storeFile,
      JSON.stringify({
        tasks: {
          a: {
            id: "a",
            name: "a",
            schedule: "0 2 * * *",
            kind: "slash",
            payload: "/x",
            enabled: false,
            createdAt: 1,
          },
        },
      })
    );
    const s = loadCronStore(p);
    expect(Object.keys(s.tasks)).toEqual(["a"]);
    expect(s.tasks.a.enabled).toBe(false);
  });

  it("文件损坏 → 空 store + 备份原文件", () => {
    const p = paths();
    mkdirSync(path.dirname(p.storeFile), { recursive: true });
    writeFileSync(p.storeFile, "{not json");
    const s = loadCronStore(p);
    expect(s).toEqual({ tasks: {} });
    expect(existsSync(p.storeFile)).toBe(false);
    // 备份文件名 cron.json.bak.<ts>
    const dir = path.dirname(p.storeFile);
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith("cron.json.bak."))).toBe(true);
  });
});

describe("saveCronStore + 原子写", () => {
  it("写入后 loadCronStore 能读回", () => {
    const p = paths();
    const store: CronStoreShape = {
      tasks: {
        b: {
          id: "b",
          name: "b",
          schedule: "@daily",
          kind: "shell",
          payload: "echo hi",
          enabled: true,
          createdAt: 100,
          notifyChannels: ["cli"],
          timeoutMs: 30000,
        },
      },
    };
    saveCronStore(store, p);
    const reloaded = loadCronStore(p);
    expect(reloaded.tasks.b).toEqual(store.tasks.b);
  });
});

describe("appendRunLog + readRecentRuns", () => {
  it("追加多条 → 读最近 N 条按时间逆序", () => {
    const p = paths();
    const now = Date.now();
    const r1: CronRun = {
      taskId: "T1",
      startedAt: now - 3000,
      endedAt: now - 2000,
      status: "ok",
      output: "first",
    };
    const r2: CronRun = {
      taskId: "T1",
      startedAt: now - 1500,
      endedAt: now - 500,
      status: "error",
      output: "",
      error: "boom",
    };
    appendRunLog("T1", r1, p);
    appendRunLog("T1", r2, p);
    const recent = readRecentRuns("T1", 5, p);
    expect(recent.length).toBe(2);
    expect(recent[0].output).toBe("");
    expect(recent[0].status).toBe("error");
    expect(recent[1].output).toBe("first");
  });

  it("不存在的任务 → 空数组", () => {
    expect(readRecentRuns("nope", 5, paths())).toEqual([]);
  });

  it("limit 截断", () => {
    const p = paths();
    for (let i = 0; i < 5; i++) {
      const r: CronRun = {
        taskId: "T2",
        startedAt: i * 1000,
        endedAt: i * 1000 + 100,
        status: "ok",
        output: `run-${i}`,
      };
      appendRunLog("T2", r, p);
    }
    expect(readRecentRuns("T2", 2, p).length).toBe(2);
  });

  it("默认路径基于 homedir", () => {
    const p = defaultCronPaths(tmpRoot);
    expect(p.storeFile.endsWith(path.join(".codeclaw", "cron.json"))).toBe(true);
  });
});
