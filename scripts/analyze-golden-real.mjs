#!/usr/bin/env node
/**
 * 分析 golden:ask --real 跑完后的 jsonl 报告，生成可读总结。
 * 重点：
 *   - 整体 pass / refusal 是否守住
 *   - 按 category 分类成绩
 *   - 失败题的关键 missed / triggered + answerExcerpt 头 100 字符
 *   - 真实 token usage / latency 中位数
 *
 * 用法：node scripts/analyze-golden-real.mjs [path/to/report.jsonl]
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argPath = process.argv[2];
const defaultPath = path.join(
  __dirname,
  "..",
  "test",
  "golden",
  "reports",
  `${new Date().toISOString().slice(0, 10)}-ask.jsonl`
);
const reportPath = argPath ?? defaultPath;

const lines = readFileSync(reportPath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean);

const records = [];
let summary = null;
for (const line of lines) {
  const obj = JSON.parse(line);
  if (obj.type === "record") records.push(obj);
  if (obj.type === "summary") summary = obj;
}

console.log(`# Golden Set 真测分析报告`);
console.log(`报告：${reportPath}`);
console.log(`记录数：${records.length}`);
console.log("");

// 整体
const passed = records.filter((r) => r.score?.pass).length;
const _failed = records.length - passed;
void _failed;
console.log(`## 整体`);
console.log(`- pass: ${passed} / ${records.length} (${((passed / records.length) * 100).toFixed(1)}%)`);
if (summary) console.log(`- meetsGate (≥85% overall, refusal 100%): ${summary.meetsGate ? "✅" : "❌"}`);
console.log("");

// 按 category
const byCat = new Map();
for (const r of records) {
  const cat = r.category;
  const arr = byCat.get(cat) ?? [];
  arr.push(r);
  byCat.set(cat, arr);
}
console.log(`## 按 category`);
const categoryOrder = [
  "refusal",
  "code-understanding",
  "cli-usage",
  "debug",
  "architecture",
  "tool-choice",
  "snippet",
];
for (const cat of categoryOrder) {
  const arr = byCat.get(cat) ?? [];
  if (arr.length === 0) continue;
  const p = arr.filter((r) => r.score?.pass).length;
  const flag = cat === "refusal" && p < arr.length ? " ⚠️ refusal 守不住" : "";
  console.log(`- ${cat.padEnd(20)} ${p}/${arr.length} (${((p / arr.length) * 100).toFixed(0)}%)${flag}`);
}
console.log("");

// refusal 详情
const refusal = (byCat.get("refusal") ?? []).filter((r) => !r.score?.pass);
if (refusal.length > 0) {
  console.log(`## ⚠️ refusal 失守的题（产品安全硬底线）`);
  for (const r of refusal) {
    console.log(`### ${r.id}`);
    console.log(`- missed: ${(r.score?.missed ?? []).join(" | ")}`);
    console.log(`- triggered: ${(r.score?.triggered ?? []).join(" | ") || "(none)"}`);
    console.log(`- answer head: ${(r.answerExcerpt ?? "").replace(/\n/g, " ").slice(0, 200)}`);
    console.log("");
  }
}

// 所有失败题
const allFailed = records.filter((r) => !r.score?.pass);
console.log(`## 全部 ${allFailed.length} 道失败题速览`);
for (const r of allFailed) {
  const triggered = r.score?.triggered ?? [];
  const tFlag = triggered.length > 0 ? ` triggered=[${triggered.join(",")}]` : "";
  console.log(`- ${r.id} [${r.category}/${r.difficulty}] matched=${r.score?.score ?? 0}/${r.score?.maxScore ?? 0}${tFlag}`);
  console.log(`    missed: ${(r.score?.missed ?? []).slice(0, 2).join(" | ")}${(r.score?.missed?.length ?? 0) > 2 ? "..." : ""}`);
  console.log(`    head:   ${(r.answerExcerpt ?? "").replace(/\n/g, " ").slice(0, 150)}`);
}
console.log("");

// token / latency
const withTokens = records.filter((r) => r.modelId && r.modelId !== "mock-deterministic");
if (withTokens.length > 0) {
  const lats = withTokens.map((r) => r.latencyMs).sort((a, b) => a - b);
  const median = lats[Math.floor(lats.length / 2)];
  const p95 = lats[Math.floor(lats.length * 0.95)];
  const totalLat = lats.reduce((s, x) => s + x, 0);
  console.log(`## 性能`);
  console.log(`- model: ${withTokens[0].modelId}`);
  console.log(`- 单题 latency 中位数 ${median} ms · p95 ${p95} ms · 全 31 题总计 ${(totalLat / 1000).toFixed(1)}s`);
}
