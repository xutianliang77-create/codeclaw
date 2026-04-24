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

const BUILTINS: Array<SlashCommand | SlashCommand[]> = [
  modeCommand,
  doctorCommand,
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
