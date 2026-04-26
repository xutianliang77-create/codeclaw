/**
 * CODECLAW.md 加载（M1-A.5）
 *
 * 用户级：~/.codeclaw/CODECLAW.md  跨项目偏好
 * 项目级：<workspace>/CODECLAW.md  项目特定约定（覆盖用户级）
 *
 * 找不到不报错；> 64KB 跳过（防止误把巨文件当配置）；任何 IO / 权限错误返 null。
 * 内容直接拼进 system prompt（不解析、不渲染）。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
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
