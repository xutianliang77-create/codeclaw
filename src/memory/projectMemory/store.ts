/**
 * Project Memory · Layer B（M2-02）
 *
 * 跨会话累积"事实 / 偏好 / 项目知识"的 markdown 知识库。对标 Claude Code 的 auto-memory。
 *
 * 与 sessionMemory（Layer A）的区别：
 *   - L2 sessionMemory：单会话 LLM 摘要 → data.db memory_digest（按 channel/userId 召回）
 *   - L1 / Layer A：当前会话 transcripts
 *   - **本模块（L3 / Layer B）**：跨会话项目级 markdown 文件，LLM / 用户主动写
 *
 * 不变量：
 *   - 路径 = ~/.codeclaw/projects/<sha256(realpath(workspace)).slice(16)>/memory/
 *     · realpath 规范化避免 symlink / 相对路径产生不同 hash（spec patch N4）
 *   - 单文件 ≤ 8KB（防膨胀）
 *   - MEMORY.md 索引 ≤ 200 行（超出按 createdAt 升序 trim 最旧）
 *   - 写入前过 redactSecretsInText（防 prompt injection / token 入库）
 *   - 文件名必须能 sanitize 成 [a-zA-Z0-9_-] 才允许
 *
 * 缓存（N6）：
 *   - loadAllMemoriesCached(workspace) 使用 dir.mtime 作 cache key；
 *     buildSystemPrompt 每 turn 调用，避免重复 readdir + parse
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { redactSecretsInText } from "../../lib/redactPrompt";

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  /** 文件名（不含 .md），sanitize 后只含 [a-zA-Z0-9_-] */
  name: string;
  /** 一行简介，用于 MEMORY.md 索引 + system prompt 注入 */
  description: string;
  /** 4 类：user/feedback/project/reference */
  type: MemoryType;
  /** markdown 内容（不含 frontmatter） */
  body: string;
  /** epoch ms；写入时取 Date.now()，用作时间序 trim */
  createdAt: number;
  /** 文件绝对路径（loadAllMemories 返回时填；write 后也填） */
  filePath: string;
}

export const MAX_ENTRY_BYTES = 8 * 1024;
export const MAX_INDEX_LINES = 200;

const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);
const NAME_SANITIZE_REGEX = /[^a-zA-Z0-9_-]/g;

/** 进程内缓存：dir mtime 没变就复用 list，避免 readdir + parse 开销（N6） */
interface MemoryCache {
  mtimeMs: number;
  entries: MemoryEntry[];
}
const cache = new Map<string, MemoryCache>();

/**
 * 计算项目隔离 memory 目录。
 * 用 realpath 规范化（symlink 解析）+ resolve（相对绝对统一）后再 hash，避免
 * `cd ~/proj` vs `cd /home/x/proj` 拿到不同目录（spec patch N4）。
 */
export function getMemoryDir(workspace: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(path.resolve(workspace));
  } catch {
    // workspace 不存在时（测试 / 启动早期）退回 resolve（不抛错）
    canonical = path.resolve(workspace);
  }
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const dir = path.join(os.homedir(), ".codeclaw", "projects", hash, "memory");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadAllMemories(workspace: string): MemoryEntry[] {
  const dir = getMemoryDir(workspace);
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  const entries: MemoryEntry[] = [];
  for (const f of files) {
    const parsed = parseMemoryFile(path.join(dir, f));
    if (parsed) entries.push(parsed);
  }
  // 按 createdAt 升序（旧 → 新），便于 trim 最旧
  entries.sort((a, b) => a.createdAt - b.createdAt);
  return entries;
}

/** 缓存版本：mtime 没变直接返；buildSystemPrompt 每 turn 调度用此（N6） */
export function loadAllMemoriesCached(workspace: string): MemoryEntry[] {
  const dir = getMemoryDir(workspace);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(dir).mtimeMs;
  } catch {
    return [];
  }
  const hit = cache.get(dir);
  if (hit && hit.mtimeMs === mtimeMs) return hit.entries;
  const entries = loadAllMemories(workspace);
  cache.set(dir, { mtimeMs, entries });
  return entries;
}

/** 仅测试用：清缓存以模拟新进程 */
export function _clearMemoryCacheForTest(): void {
  cache.clear();
}

export interface WriteMemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

/**
 * 写入一条 memory entry。
 * - sanitize name → [a-zA-Z0-9_-]，空 / 全特殊字符抛错
 * - validate type 必须在 4 类内
 * - 过 redactSecretsInText（防 secret / prompt injection）
 * - 文件总字节 > 8KB 抛错
 * - 写完更新 MEMORY.md 索引（按 createdAt 升序，trim 最旧）
 */
export function writeMemory(workspace: string, input: WriteMemoryInput): MemoryEntry {
  if (!VALID_TYPES.has(input.type)) {
    throw new Error(`invalid memory type: ${input.type}; allowed: user/feedback/project/reference`);
  }
  const sanitized = sanitizeName(input.name);
  if (!sanitized) {
    throw new Error(`memory name sanitizes to empty: ${JSON.stringify(input.name)}`);
  }
  const redactedBody = redactSecretsInText(input.body).output;
  const redactedDescription = redactSecretsInText(input.description).output;
  const createdAt = Date.now();
  const dir = getMemoryDir(workspace);
  const filePath = path.join(dir, `${sanitized}.md`);
  const content = buildFrontmatter({
    name: sanitized,
    description: redactedDescription,
    type: input.type,
    createdAt,
  }) + "\n" + redactedBody.trim() + "\n";
  if (Buffer.byteLength(content, "utf8") > MAX_ENTRY_BYTES) {
    throw new Error(`memory entry too large (>${MAX_ENTRY_BYTES} bytes after redaction)`);
  }
  writeFileSync(filePath, content, "utf8");
  rebuildIndex(workspace);
  // 失效缓存
  cache.delete(dir);
  return {
    name: sanitized,
    description: redactedDescription,
    type: input.type,
    body: redactedBody,
    createdAt,
    filePath,
  };
}

export function removeMemory(workspace: string, name: string): boolean {
  const dir = getMemoryDir(workspace);
  const sanitized = sanitizeName(name);
  if (!sanitized) return false;
  const filePath = path.join(dir, `${sanitized}.md`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  rebuildIndex(workspace);
  cache.delete(dir);
  return true;
}

/** 全清当前项目 memory；返回删除条数（不删 MEMORY.md 索引；rebuild 重建为空） */
export function clearAllMemories(workspace: string): number {
  const dir = getMemoryDir(workspace);
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  for (const f of files) unlinkSync(path.join(dir, f));
  rebuildIndex(workspace);
  cache.delete(dir);
  return files.length;
}

function rebuildIndex(workspace: string): void {
  const entries = loadAllMemories(workspace); // 按 createdAt 升序
  let lines: string[] = ["# Project Memory Index", ""];
  for (const e of entries) {
    lines.push(`- [${e.name}](${e.name}.md) — ${e.description}`);
  }
  // trim：超出 200 行时砍最旧（数组前部）；保留头 2 行（标题 + 空行）+ 末尾 (200-2) 行
  if (lines.length > MAX_INDEX_LINES) {
    const head = lines.slice(0, 2);
    const tail = lines.slice(-(MAX_INDEX_LINES - 2));
    lines = [...head, ...tail];
  }
  const dir = getMemoryDir(workspace);
  writeFileSync(path.join(dir, "MEMORY.md"), lines.join("\n") + "\n", "utf8");
}

function buildFrontmatter(opts: {
  name: string;
  description: string;
  type: MemoryType;
  createdAt: number;
}): string {
  // 简易 YAML—— 不引 yaml 库，字段都是简单字符串（description 单行、type 限定字典）
  // 万一 description 含 ":" 等也先 strip 控制字符
  const safeDesc = opts.description.replace(/[\r\n]/g, " ").slice(0, 200);
  return [
    "---",
    `name: ${opts.name}`,
    `description: ${safeDesc}`,
    `type: ${opts.type}`,
    `createdAt: ${opts.createdAt}`,
    "---",
  ].join("\n");
}

function parseMemoryFile(filePath: string): MemoryEntry | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return null;
    const fm = parseFrontmatter(m[1]);
    const fmName = typeof fm.name === "string" ? fm.name : "";
    const fmType = typeof fm.type === "string" ? fm.type : "";
    const fmDesc = typeof fm.description === "string" ? fm.description : "";
    if (!fmName || !fmType || !VALID_TYPES.has(fmType as MemoryType)) return null;
    return {
      name: fmName,
      description: fmDesc,
      type: fmType as MemoryType,
      body: m[2].trim(),
      createdAt: typeof fm.createdAt === "number" ? fm.createdAt : 0,
      filePath,
    };
  } catch {
    return null;
  }
}

function parseFrontmatter(text: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const line of text.split("\n")) {
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (!key) continue;
    if (key === "createdAt") {
      const n = Number(value);
      if (!Number.isNaN(n)) out[key] = n;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function sanitizeName(name: string): string {
  return name.replace(NAME_SANITIZE_REGEX, "_").replace(/^_+|_+$/g, "");
}
