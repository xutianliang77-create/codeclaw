import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import Database from "better-sqlite3";

import { readConfig, resolveConfigPaths } from "../lib/config";
import { ProviderRegistry } from "../provider/registry";
import { openAuditDb } from "../storage/audit";
import { AuditLog } from "../storage/auditLog";
import { VERSION } from "../version";

export async function runDoctor(): Promise<string> {
  const paths = resolveConfigPaths();
  const config = await readConfig(paths);
  const registry = await ProviderRegistry.create({ paths });
  const providers = registry.list();
  const lines = [
    `CodeClaw ${VERSION}`,
    `node: ${process.version}`,
    `bun: ${process.versions.bun ?? "not available"}`,
    `platform: ${process.platform}`,
    `cwd: ${process.cwd()}`,
    `config: ${paths.configFile}`,
    `providers-file: ${paths.providersFile}`,
    `default-provider: ${config?.provider.default ?? "not configured"}`,
    `fallback-provider: ${config?.provider.fallback ?? "not configured"}`,
    "",
    "providers:",
  ];

  // 并行探测所有 configured provider 的 baseUrl 联通性
  const probes = await Promise.all(
    providers.map(async (p) =>
      p.configured && p.baseUrl ? probeBaseUrl(p.baseUrl) : null
    )
  );

  for (const [idx, provider] of providers.entries()) {
    lines.push(
      `- ${provider.type} (${provider.displayName})`,
      `  configured: ${provider.configured}`,
      `  available: ${provider.available}`,
      `  model: ${provider.model}`,
      `  baseUrl: ${provider.baseUrl}`,
      `  reason: ${provider.reason}`
    );
    const probe = probes[idx];
    if (probe) {
      lines.push(
        probe.ok
          ? `  reachable: yes (${probe.status} in ${probe.durationMs}ms)`
          : `  reachable: no (${probe.error ?? "unknown"} after ${probe.durationMs}ms)`
      );
    }
  }

  // —— P0-W1-13：新增 storage / tokenFile / runtime / libs 诊断块 ————————————

  lines.push("", "storage:");
  const dataDbPath = path.join(paths.configDir, "data.db");
  const auditDbPath = path.join(paths.configDir, "audit.db");
  for (const { label, filePath } of [
    { label: "data.db", filePath: dataDbPath },
    { label: "audit.db", filePath: auditDbPath },
  ]) {
    const info = inspectDb(filePath);
    if (!info.exists) {
      lines.push(`- ${label}: ${filePath}  (not yet initialized)`);
      continue;
    }
    if (info.error) {
      lines.push(`- ${label}: ${filePath}  error: ${info.error}`);
      continue;
    }
    lines.push(
      `- ${label}: ${filePath}`,
      `  size: ${formatBytes(info.size ?? 0)}  mode: ${info.mode}  journal: ${info.journal}`
    );

    if (label === "data.db") {
      const pending = inspectApprovalsPending(filePath);
      if (pending !== null) {
        lines.push(`  pending approvals: ${pending}`);
      }
    }

    if (label === "audit.db") {
      const chain = inspectAuditChain(filePath);
      if ("ok" in chain) {
        lines.push(
          chain.ok
            ? `  chain: ok (${chain.checked} events verified in ${chain.durationMs}ms)`
            : chain.brokenAt
            ? `  chain: BROKEN at ${chain.brokenAt} after ${chain.checked ?? 0} events: ${chain.reason ?? "unknown"}`
            : `  chain: error (${chain.error ?? "unknown"})`
        );
      }
    }
  }

  const tokenFilePath = resolveTokenFilePath(config?.gateway?.bots?.ilinkWechat?.tokenFile);
  if (tokenFilePath) {
    lines.push("", "tokenFile:");
    if (!existsSync(tokenFilePath)) {
      lines.push(`- ${tokenFilePath}  (not created; run 'codeclaw wechat login')`);
    } else if (platform() === "win32") {
      lines.push(`- ${tokenFilePath}  (Windows: POSIX mode check skipped)`);
    } else {
      const mode = statSync(tokenFilePath).mode & 0o777;
      const marker = mode === 0o600 ? "OK" : "WARN need 0o600";
      lines.push(`- ${tokenFilePath}  mode: 0o${mode.toString(8)}  ${marker}`);
    }
  }

  lines.push("", "runtime:");
  lines.push(`- node: ${process.version}`);
  const npmV = probe("npm", ["-v"]);
  if (npmV) lines.push(`- npm: ${npmV}`);
  const pyV = probe(process.env.CODECLAW_PYTHON ?? "python3", ["--version"]);
  lines.push(`- python: ${pyV ?? "not installed (multilspy fallback unavailable)"}`);
  const gccV = probe("gcc", ["--version"])?.split("\n")[0];
  if (gccV) lines.push(`- gcc: ${gccV}`);
  const makeV = probe("make", ["--version"])?.split("\n")[0];
  if (makeV) lines.push(`- make: ${makeV}`);

  lines.push("", "libs:");
  for (const pkg of ["better-sqlite3", "ulid", "@noble/hashes", "pino"]) {
    const v = readPkgVersion(pkg);
    lines.push(`- ${pkg}: ${v ?? "not installed"}`);
  }

  return lines.join("\n");
}

// —— 辅助函数（与上方函数作用范围一致；保持纯函数 + 零副作用） ————————————

/**
 * 跑一遍 audit.db 的 hash 链 verify，确认未被篡改/断链。
 * audit.db 不存在时返回 { skipped: true }。失败会捕获，doctor 继续跑。
 */
export function inspectAuditChain(auditDbPath: string):
  | { skipped: true }
  | { ok: true; checked: number; durationMs: number }
  | { ok: false; checked?: number; brokenAt?: string; reason?: string; error?: string } {
  if (!existsSync(auditDbPath)) return { skipped: true };
  let handle: ReturnType<typeof openAuditDb> | null = null;
  try {
    handle = openAuditDb({
      path: auditDbPath,
      singleton: false,
      readonly: true,
      runMigrations: false,
    });
    const r = new AuditLog(handle.db).verify();
    if (r.ok) return { ok: true, checked: r.checkedCount, durationMs: r.durationMs };
    return {
      ok: false,
      checked: r.checkedCount,
      brokenAt: r.brokenAt,
      reason: r.reason,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    handle?.close();
  }
}

/** 数 approvals 表里 status='pending' 的条数。data.db 不存在或表缺失返回 null。 */
export function inspectApprovalsPending(dataDbPath: string): number | null {
  if (!existsSync(dataDbPath)) return null;
  try {
    const db = new Database(dataDbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT COUNT(*) as count FROM approvals WHERE status = 'pending'")
        .get() as { count: number } | undefined;
      return row?.count ?? 0;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * 探测 provider baseUrl 联通性：HEAD 请求 + 3s timeout。
 * 返回 ok:true 表示能拿到响应（任意状态码均算可达，业务错误不在此判）。
 */
export async function probeBaseUrl(
  url: string,
  timeoutMs = 3000
): Promise<{ ok: boolean; status?: number; durationMs: number; error?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "HEAD", signal: ac.signal });
    return { ok: true, status: res.status, durationMs: Date.now() - start };
  } catch (err) {
    return { ok: false, durationMs: Date.now() - start, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

function inspectDb(dbPath: string): {
  exists: boolean;
  size?: number;
  mode?: string;
  journal?: string;
  error?: string;
} {
  if (!existsSync(dbPath)) return { exists: false };
  try {
    const st = statSync(dbPath);
    const db = new Database(dbPath, { readonly: true });
    const journal = (db.pragma("journal_mode", { simple: true }) as string) ?? "unknown";
    db.close();
    return {
      exists: true,
      size: st.size,
      mode: "0o" + (st.mode & 0o777).toString(8),
      journal,
    };
  } catch (err) {
    return { exists: true, error: (err as Error).message };
  }
}

function probe(cmd: string, args: string[], timeoutMs = 3000): string | null {
  try {
    const out = execFileSync(cmd, args, {
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out.trim().split("\n")[0];
    return first ? first : null;
  } catch {
    return null;
  }
}

function resolveTokenFilePath(raw: string | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith("~/")) return path.join(homedir(), raw.slice(2));
  if (raw === "~") return homedir();
  return path.resolve(raw);
}

function readPkgVersion(name: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require(`${name}/package.json`) as { version?: string };
    return pkg?.version ?? null;
  } catch {
    return null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
