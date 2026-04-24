/**
 * audit.db 独立连接（ADR-001 §5 / 详细技术设计 §7.2）
 *
 * 为什么独立：
 *   - 主库损坏不牵连审计链
 *   - 可以独立权限（chmod 600）与备份节奏
 *   - 追加写句柄 vs 只读 verify 句柄分离
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { migrateIfNeeded } from "./migrate";

export interface OpenAuditDbOptions {
  path?: string;
  singleton?: boolean;
  runMigrations?: boolean;
  readonly?: boolean;
}

export interface AuditDbHandle {
  db: Database.Database;
  path: string;
  close(): void;
}

let singleton: AuditDbHandle | null = null;

export function defaultAuditDbPath(): string {
  return path.join(homedir(), ".codeclaw", "audit.db");
}

export function openAuditDb(opts: OpenAuditDbOptions = {}): AuditDbHandle {
  const {
    path: dbPath = defaultAuditDbPath(),
    singleton: asSingleton = true,
    runMigrations = true,
    readonly = false,
  } = opts;

  if (asSingleton && singleton) {
    if (singleton.path !== dbPath) {
      throw new Error(
        `audit.db singleton already open at ${singleton.path}; refusing to open second singleton at ${dbPath}`
      );
    }
    return singleton;
  }

  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { readonly });
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
  }

  if (runMigrations && !readonly) {
    migrateIfNeeded(db, "audit");
  }

  const handle: AuditDbHandle = {
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

export function closeAuditDb(handle?: AuditDbHandle): void {
  if (handle) {
    handle.close();
    return;
  }
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}

export function getAuditDb(): Database.Database {
  if (!singleton) {
    throw new Error("audit.db is not open; call openAuditDb() first");
  }
  return singleton.db;
}
