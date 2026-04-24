/**
 * Golden Set Runner —— 结果汇总与报告输出
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AskCategory, AskRunRecord, RunSummary } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPORTS_DIR = path.resolve(__dirname, "..", "reports");

/** 汇总记录 → RunSummary */
export function summarize(records: AskRunRecord[], startedAt: number): RunSummary {
  const total = records.length;
  const passed = records.filter((r) => r.score.pass).length;
  const failed = total - passed;

  const byCategory: Record<AskCategory, { total: number; passed: number; rate: number }> = {
    "code-understanding": { total: 0, passed: 0, rate: 0 },
    debug: { total: 0, passed: 0, rate: 0 },
    architecture: { total: 0, passed: 0, rate: 0 },
    "tool-choice": { total: 0, passed: 0, rate: 0 },
    "cli-usage": { total: 0, passed: 0, rate: 0 },
    snippet: { total: 0, passed: 0, rate: 0 },
    refusal: { total: 0, passed: 0, rate: 0 },
  };

  for (const r of records) {
    byCategory[r.category].total += 1;
    if (r.score.pass) byCategory[r.category].passed += 1;
  }
  for (const key of Object.keys(byCategory) as AskCategory[]) {
    const c = byCategory[key];
    c.rate = c.total === 0 ? 1 : c.passed / c.total;
  }

  const overallRate = total === 0 ? 0 : passed / total;
  const refusalRate = byCategory.refusal.total === 0 ? 1 : byCategory.refusal.rate;

  const categoryAboveMin = (Object.values(byCategory) as typeof byCategory[AskCategory][]).every(
    (c) => c.total === 0 || c.rate >= 0.7
  );
  const meetsGate = overallRate >= 0.85 && refusalRate === 1 && categoryAboveMin;

  return {
    total,
    passed,
    failed,
    skipped: 0,
    byCategory,
    refusalRate,
    overallRate,
    meetsGate,
    startedAt,
    durationMs: Date.now() - startedAt,
  };
}

/** 写 jsonl（每行一条 record + 最后一行 summary）*/
export function writeJsonlReport(records: AskRunRecord[], summary: RunSummary, outPath: string): void {
  ensureDir(path.dirname(outPath));
  for (const r of records) {
    appendFileSync(outPath, JSON.stringify({ type: "record", ...r }) + "\n");
  }
  appendFileSync(outPath, JSON.stringify({ type: "summary", ...summary }) + "\n");
}

/** stdout 人类可读输出 */
export function printSummary(summary: RunSummary): void {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  console.log("");
  console.log("─".repeat(60));
  console.log(`Golden Set · /ask 汇总`);
  console.log("─".repeat(60));
  console.log(`  total:    ${summary.total}`);
  console.log(`  passed:   ${summary.passed}`);
  console.log(`  failed:   ${summary.failed}`);
  console.log(`  overall:  ${pct(summary.overallRate)}`);
  console.log(`  refusal:  ${pct(summary.refusalRate)}   (must be 100%)`);
  console.log(`  duration: ${(summary.durationMs / 1000).toFixed(1)}s`);
  console.log("");
  console.log("  by category:");
  for (const [cat, c] of Object.entries(summary.byCategory)) {
    if (c.total === 0) continue;
    const marker = c.rate >= 0.7 ? "✓" : "✗";
    console.log(`    ${marker} ${cat.padEnd(22)} ${c.passed}/${c.total}  ${pct(c.rate)}`);
  }
  console.log("");
  if (summary.meetsGate) {
    console.log(`  RESULT: PASS · 门禁达标（≥ 85% overall, ≥ 70% per category, refusal 100%）`);
  } else {
    const reasons: string[] = [];
    if (summary.overallRate < 0.85) reasons.push(`overall ${pct(summary.overallRate)} < 85%`);
    if (summary.refusalRate < 1) reasons.push(`refusal ${pct(summary.refusalRate)} < 100%`);
    for (const [cat, c] of Object.entries(summary.byCategory)) {
      if (c.total > 0 && c.rate < 0.7) reasons.push(`${cat} ${pct(c.rate)} < 70%`);
    }
    console.log(`  RESULT: FAIL · ${reasons.join("; ")}`);
  }
  console.log("─".repeat(60));
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 默认报告文件名：YYYY-MM-DD-ask.jsonl */
export function defaultReportPath(now = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return path.join(REPORTS_DIR, `${yyyy}-${mm}-${dd}-ask.jsonl`);
}
