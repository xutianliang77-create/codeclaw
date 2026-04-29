/**
 * Dremio Golden Suite · 报告输出
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DremioLayer, DremioRunRecord, DremioRunSummary } from "./dremio-types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DREMIO_REPORTS_DIR = path.resolve(__dirname, "..", "reports");

const LAYER_GATES: Record<DremioLayer, number> = {
  L1: 1.0,    // L1 直调 MCP，必须 100%
  L2: 0.8,    // L2 自然语言，≥80%
  E: 0.66,    // 边界 ≥66%（3 题至少 2 过）
};

export function summarizeDremio(records: DremioRunRecord[], startedAt: number): DremioRunSummary {
  const total = records.length;
  const passed = records.filter((r) => r.score.pass).length;
  const failed = total - passed;

  const byLayer: Record<DremioLayer, { total: number; passed: number; rate: number }> = {
    L1: { total: 0, passed: 0, rate: 0 },
    L2: { total: 0, passed: 0, rate: 0 },
    E: { total: 0, passed: 0, rate: 0 },
  };

  for (const r of records) {
    byLayer[r.layer].total += 1;
    if (r.score.pass) byLayer[r.layer].passed += 1;
  }
  for (const layer of Object.keys(byLayer) as DremioLayer[]) {
    const c = byLayer[layer];
    c.rate = c.total === 0 ? 1 : c.passed / c.total;
  }

  const overallRate = total === 0 ? 0 : passed / total;
  const meetsGate = (Object.keys(byLayer) as DremioLayer[]).every((layer) => {
    const c = byLayer[layer];
    return c.total === 0 || c.rate >= LAYER_GATES[layer];
  });

  return {
    total,
    passed,
    failed,
    byLayer,
    overallRate,
    meetsGate,
    startedAt,
    durationMs: Date.now() - startedAt,
  };
}

export function writeJsonlReportDremio(
  records: DremioRunRecord[],
  summary: DremioRunSummary,
  outPath: string
): void {
  ensureDir(path.dirname(outPath));
  for (const r of records) {
    appendFileSync(outPath, JSON.stringify({ type: "record", ...r }) + "\n");
  }
  appendFileSync(outPath, JSON.stringify({ type: "summary", ...summary }) + "\n");
}

export function printSummaryDremio(summary: DremioRunSummary): void {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  console.log("");
  console.log("─".repeat(60));
  console.log(`Golden Set · Dremio MCP 汇总`);
  console.log("─".repeat(60));
  console.log(`  total:    ${summary.total}`);
  console.log(`  passed:   ${summary.passed}`);
  console.log(`  failed:   ${summary.failed}`);
  console.log(`  overall:  ${pct(summary.overallRate)}`);
  console.log(`  duration: ${(summary.durationMs / 1000).toFixed(1)}s`);
  console.log("");
  console.log("  by layer:");
  for (const layer of ["L1", "L2", "E"] as DremioLayer[]) {
    const c = summary.byLayer[layer];
    if (c.total === 0) continue;
    const gate = LAYER_GATES[layer];
    const marker = c.rate >= gate ? "✓" : "✗";
    console.log(
      `    ${marker} ${layer.padEnd(4)} ${c.passed}/${c.total}  ${pct(c.rate)}  (gate ${pct(gate)})`
    );
  }
  console.log("");
  if (summary.meetsGate) {
    console.log(`  RESULT: PASS · 各层均达 gate`);
  } else {
    const reasons: string[] = [];
    for (const layer of ["L1", "L2", "E"] as DremioLayer[]) {
      const c = summary.byLayer[layer];
      if (c.total > 0 && c.rate < LAYER_GATES[layer]) {
        reasons.push(`${layer} ${pct(c.rate)} < ${pct(LAYER_GATES[layer])}`);
      }
    }
    console.log(`  RESULT: FAIL · ${reasons.join("; ")}`);
  }
  console.log("─".repeat(60));
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function defaultDremioReportPath(now = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return path.join(DREMIO_REPORTS_DIR, `${yyyy}-${mm}-${dd}-dremio.jsonl`);
}
