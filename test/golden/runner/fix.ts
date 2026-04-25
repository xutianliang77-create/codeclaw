#!/usr/bin/env tsx
/**
 * Golden Set · /fix runner 入口（baseline）
 *
 * 当前实现 = 不接 LLM 的"骨架 baseline"：
 *   - --dry-run        仅加载 + 校验 fixture
 *   - --verify-broken  跑 setup + verify_broken（确认 bug 在）
 *   - --post-verify    跳过 LLM 直接跑 post_verify（手动 patch 后用，验证 reference 解可达）
 *   - 默认 = --verify-broken
 *
 * 接 real LLM 走 /fix 流程的版本留在 P1（避免 CI 不稳定 + LLM 成本）。
 *
 * Exit code:
 *   0 = 全部 fixture 通过当前阶段
 *   1 = 至少一题失败
 *   2 = runner 自身错误
 */

import process from "node:process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { loadAllFix, FixLoaderError } from "./fix-loader";
import { runShell, assertVerifyBroken, assertPostVerify } from "./fix-scorer";
import type { FixDifficulty, FixRunRecord, FixRunnerConfig, FixSummary } from "./fix-types";

function parseArgs(argv: string[]): FixRunnerConfig & { mode: "dry-run" | "verify-broken" | "post-verify" } {
  const cfg: FixRunnerConfig = {};
  let mode: "dry-run" | "verify-broken" | "post-verify" = "verify-broken";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        mode = "dry-run";
        cfg.dryRun = true;
        break;
      case "--verify-broken":
        mode = "verify-broken";
        cfg.verifyBrokenOnly = true;
        break;
      case "--post-verify":
        mode = "post-verify";
        break;
      case "--skip-install":
        cfg.skipInstall = true;
        break;
      case "--id": {
        const v = argv[++i];
        if (v) cfg.ids = (cfg.ids ?? []).concat(v.split(","));
        break;
      }
      case "--difficulty": {
        const v = argv[++i];
        if (v)
          cfg.difficultyFilter = (cfg.difficultyFilter ?? []).concat(
            v.split(",").map((s) => s.trim() as FixDifficulty)
          );
        break;
      }
      case "--report":
        cfg.reportPath = argv[++i];
        break;
      case "--verbose":
      case "-v":
        cfg.verbose = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }
  return { ...cfg, mode };
}

function printHelp(): void {
  console.log(`
Golden Set · /fix runner (baseline)

Usage:
  tsx test/golden/runner/fix.ts [options]

Modes (mutually exclusive; default = verify-broken):
  --dry-run         Validate fixtures only; no shell exec.
  --verify-broken   Run setup.install + setup.verify_broken (default).
  --post-verify     Run expected.post_verify only (assumes patch applied).

Filters & flags:
  --id FIX-01,FIX-02   Run subset.
  --difficulty easy    Filter by difficulty.
  --skip-install       Skip setup.install (deps already provisioned).
  --report <path>      Write jsonl report.
  --verbose, -v        Per-fixture detail.

Exit codes:
  0 = all fixtures pass current stage
  1 = at least one fail
  2 = runner error
`);
}

function defaultReportPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve("test/golden/reports", `fix-${stamp}.jsonl`);
}

function writeReport(records: FixRunRecord[], summary: FixSummary, dest: string): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r));
  lines.push(JSON.stringify({ kind: "summary", ...summary }));
  writeFileSync(dest, lines.join("\n") + "\n", "utf8");
}

function printSummary(summary: FixSummary): void {
  const ms = summary.totalDurationMs;
  console.log("");
  console.log(`/fix baseline: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.errored} errored (${(ms / 1000).toFixed(1)}s)`);
}

async function main(): Promise<number> {
  const cfg = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  let tasks;
  try {
    tasks = loadAllFix();
  } catch (err) {
    if (err instanceof FixLoaderError) console.error(`[loader] ${err.message}`);
    else console.error("[loader] unexpected error:", err);
    return 2;
  }

  if (cfg.ids?.length) {
    const set = new Set(cfg.ids);
    tasks = tasks.filter((t) => set.has(t.id));
  }
  if (cfg.difficultyFilter?.length) {
    const set = new Set(cfg.difficultyFilter);
    tasks = tasks.filter((t) => set.has(t.difficulty));
  }

  if (tasks.length === 0) {
    console.log("No /fix fixtures to run.");
    return 0;
  }

  console.log(`Loaded ${tasks.length} /fix fixture(s). Mode = ${cfg.mode}.`);

  if (cfg.mode === "dry-run") {
    console.log("[dry-run] All fixtures passed schema validation.");
    return 0;
  }

  const records: FixRunRecord[] = [];
  let errored = 0;

  for (const task of tasks) {
    if (!task.absoluteWorkspace) continue;
    const ts = Date.now();
    let setupOk = true;
    let setupDetail: string | undefined;
    let brokenOk = false;
    let brokenDetail: string | undefined;
    let postVerifyOk = false;
    let postVerifyDetail: string | undefined;
    let pass = false;
    let reason = "";

    try {
      // 1) setup.install（除非 --skip-install）
      if (!cfg.skipInstall && cfg.mode !== "post-verify") {
        const r = runShell(task.setup.install, task.absoluteWorkspace, { timeoutMs: 5 * 60_000 });
        setupOk = r.exitCode === 0;
        if (!setupOk) {
          setupDetail = `install exit=${r.exitCode}; stderr=${r.stderr.slice(0, 300)}`;
        }
      }

      // 2) verify-broken 模式：跑 verify_broken 即可
      if (cfg.mode === "verify-broken") {
        if (!setupOk) {
          reason = `setup failed: ${setupDetail}`;
        } else {
          const v = assertVerifyBroken(task);
          brokenOk = v.ok;
          brokenDetail = v.detail;
          pass = brokenOk;
          reason = brokenDetail ?? "";
        }
      } else if (cfg.mode === "post-verify") {
        const p = assertPostVerify(task);
        postVerifyOk = p.ok;
        postVerifyDetail = p.detail;
        pass = postVerifyOk;
        reason = postVerifyDetail ?? "";
      }
    } catch (err) {
      errored += 1;
      reason = `runner error: ${err instanceof Error ? err.message : String(err)}`;
    }

    const record: FixRunRecord = {
      id: task.id,
      version: task.version,
      language: task.language,
      category: task.category,
      difficulty: task.difficulty,
      setupOk,
      setupDetail,
      brokenOk,
      brokenDetail,
      postVerifyOk,
      postVerifyDetail,
      diffOk: false,
      changedFiles: 0,
      changedLines: 0,
      forbiddenHit: [],
      durationMs: Date.now() - ts,
      pass,
      reason,
      timestamp: ts,
    };
    records.push(record);

    if (cfg.verbose || !pass) {
      const marker = pass ? "✓" : "✗";
      console.log(`  ${marker} ${task.id} [${task.category}/${task.difficulty}] ${reason}`);
    }
  }

  const summary: FixSummary = {
    total: records.length,
    passed: records.filter((r) => r.pass).length,
    failed: records.filter((r) => !r.pass).length - errored,
    errored,
    totalDurationMs: Date.now() - startedAt,
    startedAt,
  };

  const reportPath = cfg.reportPath ?? defaultReportPath();
  writeReport(records, summary, reportPath);
  console.log(`\nReport: ${reportPath}`);
  printSummary(summary);

  return summary.passed === summary.total ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("runner fatal:", err);
    process.exit(2);
  });
