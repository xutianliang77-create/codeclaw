/**
 * data.db 连接封装（ADR-001 方案 C 的 SQLite 侧）
 *
 * 约定：
 *   - 进程内 singleton；`openDataDb(path)` 仅第一次打开生效
 *   - 默认 `~/.codeclaw/data.db`；测试 / 多实例用 `openDataDb(tmpPath, { singleton: false })`
 *   - WAL + synchronous=NORMAL + foreign_keys=ON + busy_timeout=5000ms
 *   - 自动 `migrateIfNeeded('data')`；失败抛错
 *   - 关闭走 `closeDataDb(db?)`（关 singleton 或指定实例）
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { migrateIfNeeded } from "./migrate";

export interface OpenDataDbOptions {
  /** 自定义路径；默认 `~/.codeclaw/data.db` */
  path?: string;
  /** 是否作为进程 singleton（默认 true） */
  singleton?: boolean;
  /** 是否跑 migration（默认 true；仅极少场景需关掉，例如自己手动控制） */
  runMigrations?: boolean;
  /** 是否只读打开（默认 false） */
  readonly?: boolean;
}

export interface DataDbHandle {
  db: Database.Database;
  path: string;
  /** 关闭；若是 singleton，同时清引用 */
  close(): void;
}

let singleton: DataDbHandle | null = null;

export function defaultDataDbPath(): string {
  return path.join(homedir(), ".codeclaw", "data.db");
}

export function openDataDb(opts: OpenDataDbOptions = {}): DataDbHandle {
  const {
    path: dbPath = defaultDataDbPath(),
    singleton: asSingleton = true,
    runMigrations = true,
    readonly = false,
  } = opts;

  if (asSingleton && singleton) {
    if (singleton.path !== dbPath) {
      throw new Error(
        `data.db singleton already open at ${singleton.path}; refusing to open second singleton at ${dbPath}`
      );
    }
    return singleton;
  }

  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { readonly });

  // PRAGMA 必须在首次连接上设置
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
  }

  if (runMigrations && !readonly) {
    migrateIfNeeded(db, "data");
  }

  const handle: DataDbHandle = {
    db,
    path: dbPath,
    close() {
      try {
        db.close();
      } finally {
        if (asSingleton && singleton === handle) singleton = null;
      }
    },
  };

  if (asSingleton) singleton = handle;
  return handle;
}

/** 关闭 singleton（若存在）。主要用于测试 / 优雅退出 */
export function closeDataDb(handle?: DataDbHandle): void {
  if (handle) {
    handle.close();
    return;
  }
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}

/** 取 singleton；未打开则抛错（应用层应先 openDataDb） */
export function getDataDb(): Database.Database {
  if (!singleton) {
    throw new Error("data.db is not open; call openDataDb() first");
  }
  return singleton.db;
}
