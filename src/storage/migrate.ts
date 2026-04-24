/**
 * 迁移执行器（幂等）
 * 参见 ADR-001 §5.4、详细技术设计 §8.2
 *
 * 约定：
 *   - migrations/{data,audit}/NNN_*.sql 两套
 *   - `schema_version` 表存当前版本（目标库建立后即建）
 *   - 启动时跑 `migrateIfNeeded(db, dir)`；已跑的版本不重复跑
 *   - 事务内执行；任一 migration 失败整个撤回
 */

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MigrationFile {
  version: number;
  name: string;
  path: string;
}

/** 扫描某子目录下所有 NNN_*.sql，按 version 升序返回 */
export function listMigrations(kind: "data" | "audit"): MigrationFile[] {
  const dir = path.join(__dirname, "migrations", kind);
  return readdirSync(dir)
    .filter((f) => /^\d{3,}_.+\.sql$/i.test(f))
    .map((f) => {
      const m = /^(\d+)_(.+)\.sql$/i.exec(f);
      if (!m) throw new Error(`bad migration filename: ${f}`);
      return { version: parseInt(m[1]!, 10), name: m[2]!, path: path.join(dir, f) };
    })
    .sort((a, b) => a.version - b.version);
}

/** 确保 `schema_version` 表存在；返回当前最高版本号（空库返回 0） */
export function currentVersion(db: Database.Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version   INTEGER PRIMARY KEY,
    name      TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

/**
 * 跑所有未应用的 migration
 * 返回已应用的版本号列表
 */
export function migrateIfNeeded(db: Database.Database, kind: "data" | "audit"): number[] {
  const applied: number[] = [];
  const current = currentVersion(db);
  const files = listMigrations(kind);

  for (const f of files) {
    if (f.version <= current) continue;
    const sql = readFileSync(f.path, "utf8");
    const insertVersion = db.prepare(
      "INSERT INTO schema_version(version, name, applied_at) VALUES (?, ?, ?)"
    );

    // SQLite 不允许事务内含 CREATE INDEX 在某些版本报 warning；
    // 用 savepoint 起手，any throw 则整个 migration 回滚。
    const tx = db.transaction(() => {
      db.exec(sql);
      insertVersion.run(f.version, f.name, Date.now());
    });
    tx();
    applied.push(f.version);
  }

  return applied;
}
