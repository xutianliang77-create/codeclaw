#!/usr/bin/env node
/**
 * CodeClaw Nightly · W4-10
 *
 * 每日跑一次的健康检查脚本：
 *   1) 全仓 secret 扫描（src/ + scripts/，跳过 node_modules / dist / .git / web/vendor）
 *   2) ~/.codeclaw/audit.db 链完整性校验（如存在）
 *   3) ~/.codeclaw/data.db 表统计（approvals / memory_digest / llm_calls_raw 计数）
 *
 * 输出 JSON 报告到 ~/.codeclaw/nightly/YYYY-MM-DD.json，方便外部 cron / dashboard 消费。
 *
 * 启用方式：
 *   - 手动：node scripts/nightly.mjs
 *   - cron（Linux/macOS）：
 *       0 2 * * * cd /path/to/CodeClaw && /usr/bin/node scripts/nightly.mjs
 *   - GH Action：见 .github/workflows/nightly.yml（如有）
 *
 * 退出码：0 = 全绿；1 = 发现问题（secret 命中 / 链断 / 致命错误）；
 *   外部 cron 用退出码触发告警；具体内容看输出文件。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

// 不扫描这些目录（生成物 / 第三方 / git 元数据 / 测试 fixture）
//
// 关于 test/：测试中含 AKIA…EXAMPLE / sk-ant-… 等 fixture 字符串验证扫描器正确性，
// 跑 nightly 时会大量误报。nightly 关注**生产代码**——/commit 与 pre-push 已经
// 在每次提交时扫所有改动；test 目录里的 secret-shaped 字符串是有意构造的。
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "web/vendor",
  ".venv-lsp",
  "doc",                 // doc/ 在 .gitignore，可能含人写的密钥示例
  "test",                // 含 secret-shaped fixture，不在 nightly 范围
]);

// 只扫这些扩展名
const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".yaml", ".yml", ".sh", ".env"]);

const REPORT_DIR = path.join(homedir(), ".codeclaw", "nightly");

function isoDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function* walkFiles(dir, baseDir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(baseDir, full);
    // 跳过名称匹配的目录（顶层和深层都跳）
    if (SKIP_DIRS.has(entry) || SKIP_DIRS.has(rel)) continue;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      yield* walkFiles(full, baseDir);
    } else if (st.isFile()) {
      const ext = path.extname(full).toLowerCase();
      if (SCAN_EXTS.has(ext) || entry.startsWith(".env")) {
        yield { full, rel, size: st.size };
      }
    }
  }
}

/**
 * scanRepo 走 inline regex 子集 —— 与 src/lib/secretScan.ts DEFAULT_RULES
 * 对齐的核心 6 条。**不动态 import dist/cli.js**：那是 ink CLI entry，import
 * 会触发 React 渲染而不是 lib export。完整版规则集（含 JWT / password 赋值）
 * 留给产品命令 /commit 使用——nightly 只做最确定的高 severity 类型。
 */
async function scanRepo() {
  return scanRepoInline();
}

function scanRepoInline() {
  const rules = [
    { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, severity: "high" },
    { name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b/g, severity: "high" },
    { name: "anthropic-key", pattern: /\bsk-ant-[0-9A-Za-z_-]{20,}\b/g, severity: "high" },
    { name: "openai-key", pattern: /\bsk-(?!ant-)[0-9A-Za-z_-]{20,}\b/g, severity: "high" },
    { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35,}\b/g, severity: "high" },
    { name: "private-key-header", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/g, severity: "high" },
  ];
  const findings = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  for (const file of walkFiles(rootDir, rootDir)) {
    scannedFiles++;
    scannedBytes += file.size;
    if (file.size > 1024 * 1024) continue; // skip > 1MB
    let text;
    try { text = readFileSync(file.full, "utf8"); } catch { continue; }
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      let m;
      while ((m = rule.pattern.exec(text)) !== null) {
        findings.push({
          rule: rule.name,
          severity: rule.severity,
          file: file.rel,
          match: m[0].length > 64 ? m[0].slice(0, 64) + "…" : m[0],
        });
        if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
      }
    }
  }
  return { findings, scannedFiles, scannedBytes };
}

async function checkAuditChain() {
  const auditPath = path.join(homedir(), ".codeclaw", "audit.db");
  if (!existsSync(auditPath)) {
    return { skipped: true, reason: "audit.db not initialized" };
  }
  // 用 better-sqlite3 + AuditLog readonly 跑 verify
  let Database;
  try {
    Database = (await import("better-sqlite3")).default;
  } catch {
    return { skipped: true, reason: "better-sqlite3 not available" };
  }
  const db = new Database(auditPath, { readonly: true });
  try {
    // 内联 verify：与 src/storage/auditLog.ts AuditLog.verify 等价的简化
    // （只验证 hash 链而不重新计算每条 hash——重新计算需要 BLAKE3 实现）
    const rows = db.prepare(
      `SELECT event_id, prev_hash, event_hash, timestamp FROM audit_events ORDER BY timestamp ASC, event_id ASC`
    ).all();
    if (rows.length === 0) return { ok: true, count: 0 };
    let prev = "genesis";
    for (const row of rows) {
      if (row.prev_hash !== prev) {
        return { ok: false, brokenAt: row.event_id, count: rows.length };
      }
      prev = row.event_hash;
    }
    return { ok: true, count: rows.length };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    db.close();
  }
}

async function dataDbStats() {
  const dataPath = path.join(homedir(), ".codeclaw", "data.db");
  if (!existsSync(dataPath)) return { skipped: true };
  let Database;
  try {
    Database = (await import("better-sqlite3")).default;
  } catch {
    return { skipped: true, reason: "better-sqlite3 not available" };
  }
  const db = new Database(dataPath, { readonly: true });
  try {
    const stats = {};
    for (const tbl of ["sessions", "approvals", "memory_digest", "llm_calls_raw", "ingress_dedup"]) {
      try {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get();
        stats[tbl] = r?.n ?? 0;
      } catch {
        stats[tbl] = null; // 表不存在
      }
    }
    return stats;
  } finally {
    db.close();
  }
}

// T18：核 .gitignore 是否覆盖敏感路径
const REQUIRED_GITIGNORE_PATTERNS = [
  "node_modules",
  ".codeclaw",
  "doc",
  ".env",
];

function checkGitignore() {
  const gitignorePath = path.join(rootDir, ".gitignore");
  let content = "";
  try {
    content = readFileSync(gitignorePath, "utf8");
  } catch {
    return { ok: false, reason: "missing .gitignore", missing: REQUIRED_GITIGNORE_PATTERNS };
  }
  const missing = REQUIRED_GITIGNORE_PATTERNS.filter(
    (p) => !content.split(/\r?\n/).some((line) => line.trim().includes(p))
  );
  return { ok: missing.length === 0, missing };
}

async function main() {
  console.log("[nightly] start at", new Date().toISOString());

  const secretResult = await scanRepo();
  console.log(
    `[nightly] secret scan: ${secretResult.findings.length} findings · ${secretResult.scannedFiles} files / ${(secretResult.scannedBytes / 1024 / 1024).toFixed(1)} MB`
  );

  const auditResult = await checkAuditChain();
  console.log(`[nightly] audit chain:`, JSON.stringify(auditResult));

  const stats = await dataDbStats();
  console.log(`[nightly] data.db:`, JSON.stringify(stats));

  // T18：.gitignore 覆盖检查
  const gitignoreResult = checkGitignore();
  console.log(`[nightly] gitignore:`, JSON.stringify(gitignoreResult));

  const report = {
    generatedAt: new Date().toISOString(),
    repo: rootDir,
    secretScan: secretResult,
    auditChain: auditResult,
    dataDbStats: stats,
    gitignore: gitignoreResult,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `${isoDate()}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[nightly] report → ${reportPath}`);

  // 退出码：发现 high-severity secret 或链断 → 1
  const hasHigh = secretResult.findings.some((f) => f.severity === "high");
  const chainBroken = auditResult.ok === false;
  if (hasHigh || chainBroken) {
    console.error("[nightly] ⚠️ issues detected — exit code 1");
    process.exit(1);
  }
  console.log("[nightly] all clean.");
}

main().catch((err) => {
  console.error("[nightly] fatal:", err);
  process.exit(2);
});
