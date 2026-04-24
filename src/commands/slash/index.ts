/**
 * Slash 命令注册表 · 统一出口
 */

export type {
  SlashCommand,
  SlashHandler,
  SlashContext,
  SlashResult,
  SlashCategory,
  SlashRisk,
  RegisterConflictPolicy,
} from "./types";

export {
  SlashRegistry,
  defineCommand,
  reply,
  noop,
  passthrough,
} from "./registry";

export { loadBuiltins, createDefaultRegistry } from "./loader";
