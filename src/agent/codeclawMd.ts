/**
 * CODECLAW.md 加载（M1-A.5）
 *
 * 用户级：~/.codeclaw/CODECLAW.md  跨项目偏好
 * 项目级：<workspace>/CODECLAW.md  项目特定约定（覆盖用户级）
 *
 * 找不到不报错；> 64KB 跳过（防止误把巨文件当配置）；任何 IO / 权限错误返 null。
 * 内容直接拼进 system prompt（不解析、不渲染）。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const MAX_CODECLAW_MD_BYTES = 64 * 1024;

export function loadUserCodeclawMd(homeDir: string = os.homedir()): string | null {
  return readMdSafely(path.join(homeDir, ".codeclaw", "CODECLAW.md"));
}

export function loadProjectCodeclawMd(workspace: string): string | null {
  return readMdSafely(path.join(workspace, "CODECLAW.md"));
}

function readMdSafely(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    const stat = statSync(p);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_CODECLAW_MD_BYTES) {
      process.stderr.write(`[codeclaw-md] ${p} > ${MAX_CODECLAW_MD_BYTES}B, skipped\n`);
      return null;
    }
    const content = readFileSync(p, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

/** /preferences add：把 line 追加到项目级 CODECLAW.md（自动创建文件 + 一行一条 markdown bullet） */
export function appendProjectCodeclawMd(workspace: string, line: string): { path: string; appended: string } {
  const p = path.join(workspace, "CODECLAW.md");
  return appendLineSafely(p, line);
}

/** /preferences user-add：追加到用户级 CODECLAW.md（自动创建 ~/.codeclaw 目录） */
export function appendUserCodeclawMd(line: string, homeDir: string = os.homedir()): { path: string; appended: string } {
  const dir = path.join(homeDir, ".codeclaw");
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "CODECLAW.md");
  return appendLineSafely(p, line);
}

function appendLineSafely(p: string, raw: string): { path: string; appended: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("preference text must not be empty");
  }
  // 单行偏好 → 自动加 markdown bullet 前缀（如果用户已经有 - 或 * 前缀就不加）
  const bullet = /^[-*]\s/.test(trimmed) ? trimmed : `- ${trimmed}`;
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "" : "\n";
  const finalContent = existing.length === 0 ? `# CodeClaw Preferences\n\n${bullet}\n` : `${existing}${sep}${bullet}\n`;
  if (Buffer.byteLength(finalContent, "utf8") > MAX_CODECLAW_MD_BYTES) {
    throw new Error(`CODECLAW.md would exceed ${MAX_CODECLAW_MD_BYTES} bytes; edit manually to compact`);
  }
  writeFileSync(p, finalContent, "utf8");
  return { path: p, appended: bullet };
}

