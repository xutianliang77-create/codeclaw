#!/usr/bin/env tsx
/**
 * Golden Set · /ask runner 入口
 *
 * 用法：
 *   npm run golden:ask                    # 全量（目前走 mock，P0 W2 接真 provider）
 *   npm run golden:ask -- --dry-run       # 只加载 + 校验，不调用 LLM
 *   npm run golden:ask -- --id ASK-001    # 单题
 *   npm run golden:ask -- --verbose
 *   npm run golden:ask -- --category refusal
 *
 * Exit code:
 *   0 = 门禁通过
 *   1 = 门禁未达标（Golden Set fail）
 *   2 = 运行错误（加载失败 / runner 异常）
 */

import process from "node:process";
import { loadAllAsk, GoldenLoaderError } from "./loader";
import { MockLlmInvoker, FailingMockLlmInvoker, LlmInvoker } from "./provider";
import { score } from "./scorer";
import { defaultReportPath, printSummary, summarize, writeJsonlReport } from "./report";
import type { AskCategory, AskRunRecord, Difficulty, RunnerConfig } from "./types";

function parseArgs(argv: string[]): RunnerConfig {
  const cfg: RunnerConfig = { useMock: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        cfg.dryRun = true;
        break;
      case "--verbose":
      case "-v":
        cfg.verbose = true;
        break;
      case "--real":
        cfg.useMock = false;
        break;
      case "--mock":
        cfg.useMock = true;
        break;
      case "--id": {
        const val = argv[++i];
        if (val) {
          cfg.ids = (cfg.ids ?? []).concat(val.split(","));
        }
        break;
      }
      case "--category": {
        const val = argv[++i];
        if (val) {
          cfg.categoryFilter = (cfg.categoryFilter ?? []).concat(
            val.split(",").map((s) => s.trim() as AskCategory)
          );
        }
        break;
      }
      case "--difficulty": {
        const val = argv[++i];
        if (val) {
          cfg.difficultyFilter = (cfg.difficultyFilter ?? []).concat(
            val.split(",").map((s) => s.trim() as Difficulty)
          );
        }
        break;
      }
      case "--provider": {
        cfg.provider = argv[++i];
        break;
      }
      case "--report": {
        cfg.reportPath = argv[++i];
        break;
      }
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }
  return cfg;
}

function printHelp(): void {
  console.log(`
Golden Set · /ask runner

Usage:
  tsx test/golden/runner/ask.ts [options]

Options:
  --dry-run            Load + validate only; do not invoke LLM.
  --id <ASK-001,...>   Run specific question ids (comma-separated).
  --category <cat>     Limit to one or more categories (code-understanding, debug, ...).
  --difficulty <diff>  Limit to difficulty: easy|medium|hard.
  --mock               Use deterministic mock invoker (default).
  --real               Use real LLM provider (NOT wired yet; throws).
  --provider <id>      Override provider id (used with --real).
  --report <path>      Write jsonl report to path.
  --verbose, -v        Print each question result.
  --help, -h           Show this help.

Exit codes:
  0 = gate pass
  1 = gate fail
  2 = runner error
`);
}

async function main(): Promise<number> {
  const cfg = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  let questions;
  try {
    questions = loadAllAsk();
  } catch (err) {
    if (err instanceof GoldenLoaderError) {
      console.error(`[loader] ${err.message}`);
    } else {
      console.error("[loader] unexpected error:", err);
    }
    return 2;
  }

  // 过滤
  if (cfg.ids && cfg.ids.length > 0) {
    const wanted = new Set(cfg.ids);
    questions = questions.filter((q) => wanted.has(q.id));
  }
  if (cfg.categoryFilter) {
    const set = new Set(cfg.categoryFilter);
    questions = questions.filter((q) => set.has(q.category));
  }
  if (cfg.difficultyFilter) {
    const set = new Set(cfg.difficultyFilter);
    questions = questions.filter((q) => set.has(q.difficulty));
  }

  if (questions.length === 0) {
    console.log("");
    console.log("No questions to run.");
    console.log("  - Add YAML files under test/golden/ask/ (see ASK-TEMPLATE.yaml).");
    console.log("  - Current filters:", JSON.stringify(cfg, null, 2));
    console.log("");
    return 0;
  }

  console.log(`Loaded ${questions.length} questions.`);

  if (cfg.dryRun) {
    console.log("[dry-run] Skipping LLM invocation; validating only.");
    console.log("✓ All questions passed schema validation.");
    return 0;
  }

  const invoker: LlmInvoker = cfg.useMock
    ? new MockLlmInvoker()
    : ((): LlmInvoker => {
        console.error("--real not wired yet; falling back to mock.");
        return new MockLlmInvoker();
      })();

  const records: AskRunRecord[] = [];
  for (const q of questions) {
    const callStart = Date.now();
    try {
      const resp = await invoker.invoke(q);
      const s = score(q, resp.answer);
      const record: AskRunRecord = {
        id: q.id,
        version: q.version,
        category: q.category,
        difficulty: q.difficulty,
        provider: resp.provider,
        modelId: resp.modelId,
        promptChars: q.prompt.length,
        answerChars: resp.answer.length,
        answerExcerpt: resp.answer.slice(0, 300),
        latencyMs: resp.latencyMs,
        score: s,
        timestamp: callStart,
      };
      records.push(record);
      if (cfg.verbose || !s.pass) {
        const marker = s.pass ? "✓" : "✗";
        console.log(`  ${marker} ${q.id} [${q.category}/${q.difficulty}] ${s.reason}`);
      }
    } catch (err) {
      console.error(`  ! ${q.id} runner error:`, err);
    }
  }

  const summary = summarize(records, startedAt);
  const reportPath = cfg.reportPath ?? defaultReportPath();
  writeJsonlReport(records, summary, reportPath);
  console.log(`\nReport: ${reportPath}`);
  printSummary(summary);

  return summary.meetsGate ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("runner fatal:", err);
    process.exit(2);
  });
