/**
 * graph builder + queries 集成单测（M4-#76 step b/c/d）
 *
 * 临时 workspace 装 fixture TS 文件 → buildGraph → 各种 query 断言。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildGraph, graphCounts } from "../../../src/graph/builder";
import { ensureGraphSchema } from "../../../src/graph/store";
import { openRagDb } from "../../../src/rag/store";
import {
  whoCalls,
  whatCalls,
  dependentsOf,
  dependenciesOf,
  findSymbolsByName,
  listSymbolsInFile,
} from "../../../src/graph/queries";

let workspace: string;
let dbPath: string;

beforeEach(() => {
  const root = path.join(os.tmpdir(), `cg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  workspace = path.join(root, "ws");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(path.join(root, "db"), { recursive: true });
  dbPath = path.join(root, "db", "rag.db");
});

afterEach(() => rmSync(path.dirname(workspace), { recursive: true, force: true }));

function withDb<T>(fn: (db: import("better-sqlite3").Database) => T): T {
  const handle = openRagDb(workspace, { path: dbPath });
  try {
    ensureGraphSchema(handle.db);
    return fn(handle.db);
  } finally {
    handle.close();
  }
}

function seed(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(workspace, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

describe("buildGraph", () => {
  it("空 workspace → 全为 0", () => {
    withDb((db) => {
      const p = buildGraph(db, workspace);
      expect(p.filesScanned).toBe(0);
      expect(graphCounts(db)).toEqual({ symbols: 0, imports: 0, calls: 0 });
    });
  });

  it("两文件 import + 调用 → 三表都有数据", () => {
    seed({
      "src/a.ts": `export function alpha() { return 1; }`,
      "src/b.ts": `import { alpha } from './a';\nexport function bravo() { return alpha(); }`,
    });
    withDb((db) => {
      buildGraph(db, workspace);
      const counts = graphCounts(db);
      expect(counts.symbols).toBeGreaterThanOrEqual(2);
      expect(counts.imports).toBeGreaterThanOrEqual(1);
      expect(counts.calls).toBeGreaterThanOrEqual(1);
    });
  });

  it("跳过 node_modules", () => {
    seed({
      "real.ts": "export const real = 1;",
      "node_modules/lib.ts": "export const lib = 1;",
    });
    withDb((db) => {
      const p = buildGraph(db, workspace);
      // 仅 real.ts 应被 parsed
      expect(p.filesParsed).toBe(1);
    });
  });
});

describe("whoCalls / whatCalls", () => {
  it("跨文件 callers 解析", () => {
    seed({
      "src/util.ts": `export function compute() { return 42; }`,
      "src/a.ts": `import { compute } from './util';\nexport function a() { return compute(); }`,
      "src/b.ts": `import { compute } from './util';\nexport function b() { return compute() + 1; }`,
    });
    withDb((db) => {
      buildGraph(db, workspace);
      const callers = whoCalls(db, "compute");
      expect(callers.map((c) => c.callerPath).sort()).toEqual(["src/a.ts", "src/b.ts"]);
      // 跨文件解析 callee_path 应填上
      expect(callers.every((c) => c.calleePath === "src/util.ts")).toBe(true);
    });
  });

  it("calleePath 限定（含同名误伤过滤）", () => {
    seed({
      "src/u1.ts": `export function compute() {}`,
      "src/u2.ts": `export function compute() {}`,
      "src/x.ts": `import { compute } from './u1';\nexport const r = compute();`,
    });
    withDb((db) => {
      buildGraph(db, workspace);
      const u1Callers = whoCalls(db, "compute", "src/u1.ts");
      expect(u1Callers).toHaveLength(1);
      expect(u1Callers[0].callerPath).toBe("src/x.ts");
      const u2Callers = whoCalls(db, "compute", "src/u2.ts");
      expect(u2Callers).toHaveLength(0);
    });
  });

  it("whatCalls：列出文件里的所有 callee", () => {
    seed({
      "src/util.ts": `export function helper() {}\nexport function deeper() {}`,
      "src/main.ts": `import { helper, deeper } from './util';\nfunction run() { helper(); deeper(); }`,
    });
    withDb((db) => {
      buildGraph(db, workspace);
      const calls = whatCalls(db, "src/main.ts");
      const names = calls.map((c) => c.calleeName).sort();
      expect(names).toContain("helper");
      expect(names).toContain("deeper");
    });
  });
});

describe("dependentsOf / dependenciesOf", () => {
  it("反查 import 关系", () => {
    seed({
      "src/core.ts": "export const core = 1;",
      "src/a.ts": `import { core } from './core';`,
      "src/b.ts": `import { core } from './core';`,
    });
    withDb((db) => {
      buildGraph(db, workspace);
      const deps = dependentsOf(db, "src/core.ts");
      expect(deps.map((d) => d.srcPath).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    });
  });

  it("dependenciesOf 列出文件 import 的所有 module（含外部包）", () => {
    seed({
      "src/x.ts": `import * as fs from 'fs';\nimport { compute } from './util';\nexport function f() {}`,
      "src/util.ts": "export function compute() {}",
    });
    withDb((db) => {
      buildGraph(db, workspace);
      const deps = dependenciesOf(db, "src/x.ts");
      const modules = deps.map((d) => d.module).sort();
      expect(modules).toEqual(["./util", "fs"]);
      // 'fs' 是外部包 → dst_path 为 NULL
      expect(deps.find((d) => d.module === "fs")?.dstPath).toBeNull();
      expect(deps.find((d) => d.module === "./util")?.dstPath).toBe("src/util.ts");
    });
  });
});

describe("findSymbolsByName / listSymbolsInFile", () => {
  it("按名查 symbol", () => {
    seed({
      "src/a.ts": "export function helper() {}",
      "src/b.ts": "export class Helper {}",
    });
    withDb((db) => {
      buildGraph(db, workspace);
      expect(findSymbolsByName(db, "helper")).toHaveLength(1);
      expect(findSymbolsByName(db, "Helper")[0].kind).toBe("class");
    });
  });

  it("listSymbolsInFile 列出文件 symbol", () => {
    seed({
      "src/multi.ts": `export function f1() {}\nexport class C1 {}\nexport const v1 = 1;\ninterface I1 {}`,
    });
    withDb((db) => {
      buildGraph(db, workspace);
      const syms = listSymbolsInFile(db, "src/multi.ts");
      expect(syms.length).toBeGreaterThanOrEqual(4);
      const names = syms.map((s) => s.name).sort();
      expect(names).toEqual(["C1", "I1", "f1", "v1"]);
    });
  });
});

describe("增量行为 · 重建（buildGraph 始终全量）", () => {
  it("第二次 build 同样数据 → 计数稳定", () => {
    seed({ "src/a.ts": "export function a() {}" });
    withDb((db) => {
      buildGraph(db, workspace);
      const c1 = graphCounts(db);
      buildGraph(db, workspace);
      const c2 = graphCounts(db);
      expect(c2).toEqual(c1);
    });
  });
});
