/**
 * CODECLAW.md 加载（M1-A.5；v0.8.1 #5 加多级 walk-up）
 *
 * 用户级：~/.codeclaw/CODECLAW.md           跨项目偏好
 * 项目级：从 cwd 向上 walk 找 CODECLAW.md，遇 .git / home / fs root 停
 *         多级合并（父级在前、子级在后），子级不覆盖父级；这样
 *         monorepo 子目录跑 codeclaw 也能拿到根级 conventions
 *
 * 找不到不报错；单文件 > 64KB 跳过；合并后总预算 64KB（超出末尾截断 + 警告）。
 * 内容直接拼进 system prompt（不解析、不渲染）。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const MAX_CODECLAW_MD_BYTES = 64 * 1024;
const MAX_WALK_DEPTH = 16;

export function loadUserCodeclawMd(homeDir: string = os.homedir()): string | null {
  return readMdSafely(path.join(homeDir, ".codeclaw", "CODECLAW.md"));
}

export function loadProjectCodeclawMd(
  workspace: string,
  homeDir: string = os.homedir()
): string | null {
  const layers: Array<{ dir: string; content: string }> = [];
  let dir = path.resolve(workspace);
  const fsRoot = path.parse(dir).root;
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    // home 目录的 CODECLAW.md 由 loadUserCodeclawMd 单独处理（约定走 ~/.codeclaw/）；
    // 这里 skip 避免重复 + 防 home 下意外的 CODECLAW.md 污染项目级
    if (dir !== homeDir) {
      const md = readMdSafely(path.join(dir, "CODECLAW.md"));
      if (md) layers.push({ dir, content: md });
    }
    if (existsSync(path.join(dir, ".git"))) break;
    if (dir === fsRoot || dir === homeDir) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (layers.length === 0) return null;
  // 单层退化到 v0.7 行为（无 header），保持向后兼容（已有测试 + system prompt 段排序不变）
  if (layers.length === 1) return layers[0].content;
  // 多层：父级排前作为基础，子级排后让最近层占 attention 末尾权重
  layers.reverse();
  const total = layers.length;
  const merged = layers
    .map(
      (l, i) =>
        `## CODECLAW.md (level ${i + 1}/${total}, dir: ${l.dir})\n\n${l.content}`
    )
    .join("\n\n---\n\n");
  if (Buffer.byteLength(merged, "utf8") <= MAX_CODECLAW_MD_BYTES) return merged;
  process.stderr.write(
    `[codeclaw-md] merged ${total} levels exceed ${MAX_CODECLAW_MD_BYTES}B, truncating tail\n`
  );
  return truncateUtf8(merged, MAX_CODECLAW_MD_BYTES);
}

/** 按 byte 上限保留前缀（二分避免切坏多字节 UTF-8）；末尾追加截断标记。 */
function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const marker = "\n\n[truncated by codeclaw 64KB CODECLAW.md merge limit]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(s.slice(0, mid), "utf8") <= budget) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + marker;
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

