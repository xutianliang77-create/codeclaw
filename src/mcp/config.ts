/**
 * MCP 配置加载（M3-01 step b）
 *
 * 路径优先级：
 *   1. <workspace>/.mcp.json    项目级（如有）
 *   2. ~/.codeclaw/mcp.json     用户级
 *
 * Schema：
 *   {
 *     "servers": {
 *       "<name>": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
 *         "env": { "FOO": "bar" },
 *         "cwd": "/optional",
 *         "disabled": false
 *       }
 *     }
 *   }
 *
 * 找不到任意配置 → 返回 { servers: {} }（不报错；用户尚未配 MCP 是合法状态）
 * JSON 解析失败 / schema 不合法 → throw 含错误来源的 Error
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

const EMPTY_CONFIG: McpConfig = { servers: {} };

export function loadMcpConfig(workspace: string, homeDir: string = os.homedir()): McpConfig {
  const projectPath = path.join(workspace, ".mcp.json");
  if (existsSync(projectPath)) {
    return parseMcpConfig(readFileSync(projectPath, "utf8"), projectPath);
  }
  const userPath = path.join(homeDir, ".codeclaw", "mcp.json");
  if (existsSync(userPath)) {
    return parseMcpConfig(readFileSync(userPath, "utf8"), userPath);
  }
  return EMPTY_CONFIG;
}

export function parseMcpConfig(text: string, source: string): McpConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `mcp config invalid JSON (${source}): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`mcp config root must be object (${source})`);
  }

  const servers = (raw as { servers?: unknown }).servers;
  if (servers === undefined) {
    return { servers: {} };
  }
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`mcp config 'servers' must be object (${source})`);
  }

  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      throw new Error(`mcp config servers.${name} must be object (${source})`);
    }
    const v = value as Record<string, unknown>;
    if (typeof v.command !== "string" || !v.command) {
      throw new Error(`mcp config servers.${name}.command must be non-empty string (${source})`);
    }
    if (v.args !== undefined && !Array.isArray(v.args)) {
      throw new Error(`mcp config servers.${name}.args must be array (${source})`);
    }
    if (v.env !== undefined && (typeof v.env !== "object" || Array.isArray(v.env) || v.env === null)) {
      throw new Error(`mcp config servers.${name}.env must be object (${source})`);
    }
    out[name] = {
      command: v.command,
      ...(Array.isArray(v.args) ? { args: v.args.map((a) => String(a)) } : {}),
      ...(v.env && typeof v.env === "object"
        ? { env: Object.fromEntries(Object.entries(v.env as Record<string, unknown>).map(([k, val]) => [k, String(val)])) }
        : {}),
      ...(typeof v.cwd === "string" ? { cwd: v.cwd } : {}),
      ...(typeof v.disabled === "boolean" ? { disabled: v.disabled } : {}),
    };
  }
  return { servers: out };
}
