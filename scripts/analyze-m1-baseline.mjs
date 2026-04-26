#!/usr/bin/env node
/**
 * 解析 baseline-post-m1.jsonl，按类目聚合通过率，与 pre-M1 74% baseline 对比。
 *
 * 用法：node scripts/analyze-m1-baseline.mjs <jsonl-path>
 *
 * 输出 markdown 到 stdout（可重定向到 doc/analysis/m1-baseline-compare.md）。
 */

import { readFileSync } from "node:fs";
import { argv } from "node:process";

const path = argv[2] ?? "/tmp/baseline-post-m1.jsonl";

// pre-M1 baseline（来自 P1 收口前真测，记忆里写的 74%）
const PRE_M1 = {
  overall: 74.0,
  byCategory: {
    "code-understanding": 50.0,
    "debug": null,
    "cli-usage": null,
    "architecture": null,
    "tool-choice": null,
    "refusal": null,
    "snippet": null,
  },
};

const lines = readFileSync(path, "utf8")
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

const records = lines.map((l) => JSON.parse(l));

const byCat = new Map();
let total = 0;
let passed = 0;
let totalLatency = 0;

for (const r of records) {
  const cat = r.category;
  if (!byCat.has(cat)) byCat.set(cat, { total: 0, passed: 0, missed: [] });
  const bucket = byCat.get(cat);
  bucket.total += 1;
  total += 1;
  totalLatency += r.latencyMs ?? 0;
  if (r.score?.pass) {
    bucket.passed += 1;
    passed += 1;
  } else {
    bucket.missed.push({
      id: r.id,
      reason: r.score?.reason ?? "(no reason)",
      missed: r.score?.missed ?? [],
      triggered: r.score?.triggered ?? [],
    });
  }
}

const overallPct = (passed / total) * 100;
const avgLatency = totalLatency / total / 1000;

const fmt = (n) => n.toFixed(1);
const delta = (post, pre) => {
  if (pre == null) return "(no pre)";
  const d = post - pre;
  const sign = d >= 0 ? "+" : "";
  return `${sign}${fmt(d)} pp`;
};

const lines_out = [];
lines_out.push("# M1 Baseline 对比报告");
lines_out.push("");
lines_out.push(`- 日期：${new Date().toISOString().slice(0, 10)}`);
lines_out.push(`- 测试集：100 题 LLM-judge`);
lines_out.push(`- Provider：${records[0]?.provider ?? "?"} / ${records[0]?.modelId ?? "?"}`);
lines_out.push(`- 配置：CODECLAW_AGENT_GRADE=true, CODECLAW_NATIVE_TOOLS=true, GOLDEN_M1_SYSTEM_PROMPT=true`);
lines_out.push("");
lines_out.push("## 总体");
lines_out.push("");
lines_out.push(`| 指标 | pre-M1 | post-M1 | Δ |`);
lines_out.push(`|---|---|---|---|`);
lines_out.push(`| 总通过率 | ${fmt(PRE_M1.overall)}% | **${fmt(overallPct)}%** | ${delta(overallPct, PRE_M1.overall)} |`);
lines_out.push(`| 总题数 | 100 | ${total} | - |`);
lines_out.push(`| 通过题数 | 74 | ${passed} | - |`);
lines_out.push(`| 平均延迟 | ~41s | ${fmt(avgLatency)}s | - |`);
lines_out.push("");

const m1Gate = overallPct >= 85 ? "✅ PASS（≥85% 出口达标）" : "❌ MISS（plan §7 出口要求 ≥85%）";
lines_out.push(`**M1 出口门禁**：${m1Gate}`);
lines_out.push("");

lines_out.push("## 各类目对比");
lines_out.push("");
lines_out.push(`| 类目 | post-M1 | pre-M1 | Δ |`);
lines_out.push(`|---|---|---|---|`);
const sortedCats = Array.from(byCat.keys()).sort();
for (const cat of sortedCats) {
  const b = byCat.get(cat);
  const pct = (b.passed / b.total) * 100;
  const pre = PRE_M1.byCategory[cat];
  lines_out.push(`| ${cat} | ${b.passed}/${b.total} (${fmt(pct)}%) | ${pre != null ? fmt(pre) + "%" : "(n/a)"} | ${pre != null ? delta(pct, pre) : ""} |`);
}
lines_out.push("");

lines_out.push("## 失败题清单");
lines_out.push("");
for (const cat of sortedCats) {
  const b = byCat.get(cat);
  if (b.missed.length === 0) continue;
  lines_out.push(`### ${cat} (${b.missed.length} 个失败)`);
  lines_out.push("");
  for (const f of b.missed) {
    lines_out.push(`- **${f.id}**: ${f.reason}`);
    if (f.missed?.length) lines_out.push(`  - missed: ${JSON.stringify(f.missed)}`);
    if (f.triggered?.length) lines_out.push(`  - triggered: ${JSON.stringify(f.triggered)}`);
  }
  lines_out.push("");
}

console.log(lines_out.join("\n"));
