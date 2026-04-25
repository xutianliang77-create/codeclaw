/**
 * Slash 命令加载器
 *
 * 从 `./builtins/*.ts` 收集默认命令并注册到传入的 registry。
 * 每个 builtin 模块必须 default export 一个 SlashCommand（或 SlashCommand[]）。
 *
 * 说明：
 *   - 这里用显式 import 清单，不用 glob import（ESM + tsc 更稳）。
 *   - 新增 builtin 时同时改：
 *       1. builtins/xxx.ts
 *       2. 本文件 BUILTINS 数组
 *   - 未来改为基于文件扫描 require.context 风格由 P1+ 再说。
 */

import type { SlashCommand } from "./types";
import type { SlashRegistry } from "./registry";

import modeCommand from "./builtins/mode";
import doctorCommand from "./builtins/doctor";
import statusCommand from "./builtins/status";
import resumeCommand from "./builtins/resume";
import sessionCommand from "./builtins/session";
import providersCommand from "./builtins/providers";
import approvalsCommand from "./builtins/approvals";
import contextCommand from "./builtins/context";
import memoryCommand from "./builtins/memory";
import diffCommand from "./builtins/diff";
import skillsCommand from "./builtins/skills";
import hooksCommand from "./builtins/hooks";
import initCommand from "./builtins/init";
import compactCommand from "./builtins/compact";
import modelCommand from "./builtins/model";
import summaryCommand from "./builtins/summary";
import exportCommand from "./builtins/exportSession";
import reloadPluginsCommand from "./builtins/reloadPlugins";
import debugToolCallCommand from "./builtins/debugToolCall";
import mcpCommand from "./builtins/mcp";
import wechatCommand from "./builtins/wechat";
import helpCommand from "./builtins/help";
import planCommand from "./builtins/plan";
import reviewCommand from "./builtins/review";
import orchestrateCommand from "./builtins/orchestrate";
import costCommand from "./builtins/cost";
import commitCommand from "./builtins/commit";
import askCommand from "./builtins/ask";
import fixCommand from "./builtins/fix";
import endCommand from "./builtins/end";
import forgetCommand from "./builtins/forget";

const BUILTINS: Array<SlashCommand | SlashCommand[]> = [
  helpCommand,
  planCommand,
  reviewCommand,
  orchestrateCommand,
  costCommand,
  commitCommand,
  askCommand,
  fixCommand,
  modeCommand,
  doctorCommand,
  statusCommand,
  resumeCommand,
  sessionCommand,
  providersCommand,
  approvalsCommand,
  contextCommand,
  memoryCommand,
  diffCommand,
  skillsCommand,
  hooksCommand,
  initCommand,
  compactCommand,
  modelCommand,
  summaryCommand,
  exportCommand,
  reloadPluginsCommand,
  debugToolCallCommand,
  mcpCommand,
  wechatCommand,
  endCommand,
  forgetCommand,
];

export function loadBuiltins(registry: SlashRegistry): number {
  let count = 0;
  for (const entry of BUILTINS) {
    const cmds = Array.isArray(entry) ? entry : [entry];
    for (const cmd of cmds) {
      registry.register(cmd);
      count++;
    }
  }
  return count;
}

/** 便捷：创建一个装好所有 builtin 的 registry */
export async function createDefaultRegistry(): Promise<SlashRegistry> {
  const { SlashRegistry } = await import("./registry");
  const reg = new SlashRegistry();
  loadBuiltins(reg);
  return reg;
}
