/**
 * Hooks 配置加载（M3-04 step 1）
 *
 * 路径优先级（找到第一个就用）：
 *   1. <workspace>/.codeclaw/settings.json   项目级
 *   2. ~/.codeclaw/settings.json             用户级
 *   3. ~/.claude/settings.json               兼容 Claude Code（设计借鉴）
 *
 * schema（兼容 Claude Code）：
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "^Bash\\(.*\\)$",
 *           "hooks": [
 *             { "type": "command", "command": "scripts/precheck.sh", "timeout": 5000 }
 *           ]
 *         }
 *       ],
 *       "UserPromptSubmit": [...],
 *       "PostToolUse": [...],
 *       "Stop": [...],
 *       "SessionStart": [...]
 *     }
 *   }
 *
 * 找不到任意配置 → 返回 { hooks: {} }（不报错；用户没配 hooks 是合法状态）
 * JSON 解析失败 / schema 不合法 → throw 含错误来源的 Error
 *
 * 不支持的字段（Claude Code settings.json 还有 permissions/env/statusLine/modelLine 等）
 * 在本步只解析 hooks 字段，其他静默忽略，待 M3-04 step 4-6 / future 补
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export type HookEventType =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SessionStart";

export const HOOK_EVENT_TYPES: HookEventType[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
];

export interface HookCommand {
  type: "command";
  command: string;
  /** 默认 5000；UserPromptSubmit 阻塞型默认 200（runner 解析时按 event 类型加默认） */
  timeout?: number;
}

export interface HookMatcher {
  /** 仅 PreToolUse / PostToolUse 用：tool name 的 regex；省略表示任意工具 */
  matcher?: string;
  hooks: HookCommand[];
}

export type HookSettings = {
  [K in HookEventType]?: HookMatcher[];
};

export interface CodeclawSettings {
  hooks: HookSettings;
  /** M3-04 step 4-5 status line 配置；本步只占位字段 */
  statusLine?: {
    command?: string;
    intervalMs?: number;
  };
}

const EMPTY_SETTINGS: CodeclawSettings = { hooks: {} };

export function loadSettings(workspace: string, homeDir: string = os.homedir()): CodeclawSettings {
  const candidates = [
    path.join(workspace, ".codeclaw", "settings.json"),
    path.join(homeDir, ".codeclaw", "settings.json"),
    path.join(homeDir, ".claude", "settings.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return parseSettings(readFileSync(p, "utf8"), p);
    }
  }
  return EMPTY_SETTINGS;
}

export function parseSettings(text: string, source: string): CodeclawSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `settings invalid JSON (${source}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`settings root must be object (${source})`);
  }

  const out: CodeclawSettings = { hooks: {} };
  const hooksNode = (raw as { hooks?: unknown }).hooks;
  if (hooksNode !== undefined) {
    if (typeof hooksNode !== "object" || hooksNode === null || Array.isArray(hooksNode)) {
      throw new Error(`settings.hooks must be object (${source})`);
    }
    for (const [eventName, value] of Object.entries(hooksNode as Record<string, unknown>)) {
      if (!HOOK_EVENT_TYPES.includes(eventName as HookEventType)) {
        // 未知事件名静默 skip（向前兼容 Claude Code 新事件类型）
        continue;
      }
      if (!Array.isArray(value)) {
        throw new Error(`settings.hooks.${eventName} must be array (${source})`);
      }
      out.hooks[eventName as HookEventType] = value.map((entry, i) =>
        normalizeMatcher(entry, `${source} hooks.${eventName}[${i}]`)
      );
    }
  }

  const statusLineNode = (raw as { statusLine?: unknown }).statusLine;
  if (statusLineNode !== undefined) {
    if (
      !statusLineNode ||
      typeof statusLineNode !== "object" ||
      Array.isArray(statusLineNode)
    ) {
      throw new Error(`settings.statusLine must be object (${source})`);
    }
    const sl = statusLineNode as Record<string, unknown>;
    out.statusLine = {
      ...(typeof sl.command === "string" ? { command: sl.command } : {}),
      ...(typeof sl.intervalMs === "number" ? { intervalMs: sl.intervalMs } : {}),
    };
  }

  return out;
}

function normalizeMatcher(entry: unknown, source: string): HookMatcher {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`hook entry must be object (${source})`);
  }
  const e = entry as Record<string, unknown>;
  if (!Array.isArray(e.hooks)) {
    throw new Error(`hook entry.hooks must be array (${source})`);
  }
  return {
    ...(typeof e.matcher === "string" ? { matcher: e.matcher } : {}),
    hooks: e.hooks.map((h, i) => normalizeCommand(h, `${source}.hooks[${i}]`)),
  };
}

function normalizeCommand(entry: unknown, source: string): HookCommand {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`hook command must be object (${source})`);
  }
  const e = entry as Record<string, unknown>;
  if (e.type !== "command") {
    throw new Error(`hook command.type must be 'command' (${source})`);
  }
  if (typeof e.command !== "string" || !e.command) {
    throw new Error(`hook command.command must be non-empty string (${source})`);
  }
  return {
    type: "command",
    command: e.command,
    ...(typeof e.timeout === "number" ? { timeout: e.timeout } : {}),
  };
}
