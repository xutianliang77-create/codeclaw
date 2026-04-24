import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import Database from "better-sqlite3";

import { readConfig, resolveConfigPaths } from "../lib/config";
import { ProviderRegistry } from "../provider/registry";
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

  for (const provider of providers) {
    lines.push(
      `- ${provider.type} (${provider.displayName})`,
      `  configured: ${provider.configured}`,
      `  available: ${provider.available}`,
      `  model: ${provider.model}`,
      `  baseUrl: ${provider.baseUrl}`,
      `  reason: ${provider.reason}`
    );
  }

  // —— P0-W1-13：新增 storage / tokenFile / runtime / libs 诊断块 ————————————

  lines.push("", "storage:");
  for (const { label, filePath } of [
    { label: "data.db", filePath: path.join(paths.configDir, "data.db") },
    { label: "audit.db", filePath: path.join(paths.configDir, "audit.db") },
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
