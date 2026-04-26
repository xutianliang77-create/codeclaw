/**
 * RAG chunker · 文件 → chunk 列表（M4-#75 step a）
 *
 * 策略：
 *   - 默认 30 行/chunk + 5 行 overlap（让边界附近的内容在两个 chunk 都出现）
 *   - 跳过 binary（首 8KB 含 NUL 字节认定）
 *   - 跳过 > 500KB 文件（不放索引；这种通常是日志 / 生成代码）
 *   - 跳过常见黑名单目录（node_modules / dist / .git / .venv / .next / __pycache__）
 *
 * chunk_id 格式：'<rel_path>:<line_start>'
 *   - 同文件改动后只有受影响 chunk 的 hash 变化，便于增量索引
 *
 * 不在本步范围（step b/c）：
 *   - 按 syntax 分块（function / class）：要 LSP 支持，复杂度大；先用行数兜底
 *   - 增量索引：indexer.ts 用 hash 比对决定是否重写
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const DEFAULT_CHUNK_LINES = 30;
const DEFAULT_OVERLAP_LINES = 5;
const MAX_FILE_BYTES = 500 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;

export interface ChunkInput {
  relPath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  contentHash: string;
}

export interface ChunkOptions {
  chunkLines?: number;
  overlapLines?: number;
}

export function chunkFile(absPath: string, relPath: string, opts: ChunkOptions = {}): ChunkInput[] {
  const chunkLines = Math.max(5, opts.chunkLines ?? DEFAULT_CHUNK_LINES);
  const overlap = Math.max(0, Math.min(chunkLines - 1, opts.overlapLines ?? DEFAULT_OVERLAP_LINES));

  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) {
    return [];
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(absPath);
  } catch {
    return [];
  }
  if (looksBinary(buffer)) return [];

  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/);

  const chunks: ChunkInput[] = [];
  const step = chunkLines - overlap;
  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + chunkLines);
    if (slice.length === 0) break;
    const content = slice.join("\n").trim();
    if (!content) continue;
    chunks.push({
      relPath,
      lineStart: i + 1, // 1-based
      lineEnd: Math.min(i + chunkLines, lines.length),
      content,
      contentHash: hashContent(content),
    });
    if (i + chunkLines >= lines.length) break;
  }
  return chunks;
}

export function chunkId(c: { relPath: string; lineStart: number }): string {
  return `${c.relPath}:${c.lineStart}`;
}

function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 16);
}

function looksBinary(buf: Buffer): boolean {
  const probe = buf.slice(0, Math.min(BINARY_PROBE_BYTES, buf.length));
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) return true;
  }
  return false;
}

export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".vercel",
  ".venv",
  ".venv-lsp",
  "__pycache__",
  "coverage",
  ".cache",
  ".idea",
  ".vscode",
  ".DS_Store",
]);

/** 应在外层 walker 用：判断是否要 recurse 进 dir 名 */
export function shouldSkipDir(name: string): boolean {
  if (name.startsWith(".") && !["..", "."].includes(name)) {
    // 隐藏目录默认 skip（除了 ..  /.codeclaw 也跳过 — caller 自定义白名单除外）
    return true;
  }
  return SKIPPED_DIRECTORIES.has(name);
}

export function isPathInWorkspace(absPath: string, workspace: string): boolean {
  const w = path.resolve(workspace);
  const p = path.resolve(absPath);
  return p === w || p.startsWith(w + path.sep);
}
