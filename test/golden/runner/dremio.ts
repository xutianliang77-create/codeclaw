#!/usr/bin/env tsx
/**
 * Dremio Golden Suite · runner 入口
 *
 * 用法：
 *   npm run golden:dremio                  # 全 20 题，real provider + real MCP
 *   npm run golden:dremio -- --dry-run     # 只校验 yaml schema
 *   npm run golden:dremio -- --layer L1    # 仅 L1 (direct MCP)
 *   npm run golden:dremio -- --layer L2    # 仅 L2 (NL)
 *   npm run golden:dremio -- --id DRM-001  # 单题
 *   npm run golden:dremio -- --mock        # 不调 LLM/MCP，骨架自测
 *
 * Exit code:
 *   0 = gate pass · 1 = gate fail · 2 = runner error
 *
 * 先决条件（real 模式）：
 *   - ~/.codeclaw/mcp.json 含 dremio server entry（参考 docs/INTEGRATIONS-dremio-oss.md）
 *   - 本地 Dremio OSS 已起；token 在 24h 有效期内
 *   - 本机 codeclaw provider 已配（npm run setup 或 ~/.codeclaw/providers.json）
 */

import process from "node:process";
import { loadAllDremio, DremioLoaderError } from "./dremio-loader";
import {
  MockDremioInvoker,
  RealDremioInvoker,
  type DremioInvoker,
} from "./dremio-invoker";
import { scoreDremio } from "./dremio-scorer";
import {
  defaultDremioReportPath,
  printSummaryDremio,
  summarizeDremio,
  writeJsonlReportDremio,
} from "./dremio-report";
import type {
  DremioLayer,
  DremioRunRecord,
  DremioRunnerConfig,
} from "./dremio-types";

function parseArgs(argv: string[]): DremioRunnerConfig {
  const cfg: DremioRunnerConfig = { useMock: false, judgeMode: "string" };
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
      case "--mock":
        cfg.useMock = true;
        break;
      case "--real":
        cfg.useMock = false;
        break;
      case "--id": {
        const val = argv[++i];
        if (val) cfg.ids = (cfg.ids ?? []).concat(val.split(","));
        break;
      }
      case "--layer": {
        const val = argv[++i];
        if (val) {
          cfg.layerFilter = (cfg.layerFilter ?? []).concat(
            val.split(",").map((s) => s.trim().toUpperCase() as DremioLayer)
          );
        }
        break;
      }
      case "--report":
        cfg.reportPath = argv[++i];
        break;
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
Golden Set · Dremio MCP runner

Usage:
  tsx test/golden/runner/dremio.ts [options]

Options:
  --dry-run            只加载 + 校验 yaml schema，不调 MCP / LLM
  --id <DRM-001,...>   仅跑指定题目 id（逗号分隔）
  --layer <L1|L2|E>    仅跑指定 layer
  --mock               用 deterministic mock invoker（骨架自测）
  --real               用真实 MCP + provider（默认）
  --report <path>      指定报告输出路径（默认 test/golden/reports/<date>-dremio.jsonl）
  --verbose, -v        每题打印通过/失败状态
  --help, -h

Exit codes:
  0 = gate pass · 1 = gate fail · 2 = runner error
`);
}

async function main(): Promise<number> {
  const cfg = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  let questions;
  try {
    questions = loadAllDremio();
  } catch (err) {
    if (err instanceof DremioLoaderError) console.error(`[loader] ${err.message}`);
    else console.error("[loader] unexpected error:", err);
    return 2;
  }

  if (cfg.ids && cfg.ids.length > 0) {
    const wanted = new Set(cfg.ids);
    questions = questions.filter((q) => wanted.has(q.id));
  }
  if (cfg.layerFilter && cfg.layerFilter.length > 0) {
    const set = new Set(cfg.layerFilter);
    questions = questions.filter((q) => set.has(q.layer));
  }

  if (questions.length === 0) {
    console.log("");
    console.log("No questions to run.");
    console.log("  - 在 test/golden/dremio/ 下添加 yaml（参考 DRM-TEMPLATE.yaml）");
    console.log("  - 当前过滤:", JSON.stringify(cfg, null, 2));
    return 0;
  }

  console.log(`Loaded ${questions.length} dremio questions.`);

  if (cfg.dryRun) {
    console.log("[dry-run] Skipping invocation; schema valid.");
    return 0;
  }

  let invoker: DremioInvoker;
  if (cfg.useMock) {
    invoker = new MockDremioInvoker();
    console.log("[mock] using deterministic invoker");
  } else {
    try {
      invoker = await RealDremioInvoker.create();
      const real = invoker as RealDremioInvoker;
      const ready = real.serverReady("dremio");
      const tools = real.listToolNames("dremio");
      if (!ready) {
        console.error(
          `[real] dremio MCP server not ready. 检查 ~/.codeclaw/mcp.json 和 dremio-mcp-server 是否能跑通。`
        );
      } else {
        console.log(`[real] dremio MCP ready · ${tools.length} tools available`);
      }
    } catch (err) {
      console.error(
        `[real] failed to initialize: ${err instanceof Error ? err.message : String(err)}`
      );
      return 2;
    }
  }

  const records: DremioRunRecord[] = [];
  try {
    for (const q of questions) {
      const callStart = Date.now();
      try {
        const resp = await invoker.invoke(q);
        const s = scoreDremio(q, resp.answer, resp.toolsInvoked);
        const record: DremioRunRecord = {
          id: q.id,
          version: q.version,
          layer: q.layer,
          ...(resp.provider ? { provider: resp.provider } : {}),
          ...(resp.modelId ? { modelId: resp.modelId } : {}),
          promptChars: q.prompt.length,
          answerChars: resp.answer.length,
          answerExcerpt: resp.answer.slice(0, 300),
          toolsInvoked: resp.toolsInvoked,
          latencyMs: resp.latencyMs,
          score: s,
          timestamp: callStart,
        };
        records.push(record);
        if (cfg.verbose || !s.pass) {
          const marker = s.pass ? "✓" : "✗";
          console.log(`  ${marker} ${q.id} [${q.layer}] ${s.reason}`);
        }
      } catch (err) {
        console.error(`  ! ${q.id} runner error:`, err);
      }
    }
  } finally {
    if (invoker.shutdown) {
      await invoker.shutdown().catch(() => undefined);
    }
  }

  const summary = summarizeDremio(records, startedAt);
  const reportPath = cfg.reportPath ?? defaultDremioReportPath();
  writeJsonlReportDremio(records, summary, reportPath);
  console.log(`\nReport: ${reportPath}`);
  printSummaryDremio(summary);

  return summary.meetsGate ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("dremio runner fatal:", err);
    process.exit(2);
  });
