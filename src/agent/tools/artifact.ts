/**
 * Artifact 兜底（v0.8.1 #3）
 *
 * 工具结果的「截断 vs 落盘」统一策略：
 *   - ≤ SUMMARY_BUDGET（默认 4KB）：原样作为 summary 进 messages，无侧效
 *   - > SUMMARY_BUDGET：摘要保留头 + 尾，中段省略；全文落盘
 *     `~/.codeclaw/artifacts/<sessionId>/<toolCallId>.txt`，给一行 hint
 *     告诉 LLM 用 read_artifact(path, offset, limit) 主动取段
 *
 * 这样既防止「中段直接消失导致模型推理基于残缺信息」，也不让长输出灌
 * 爆 ctx；模型若需要查中段（grep 大输出第 30k-40k 行），自己显式调
 * read_artifact 即可。
 *
 * 与现有 trimOutput（src/tools/local.ts）的关系：
 *   trimOutput 已在 LocalTool 内部把 read/bash 截到 12k 字符；wrapToolResult
 *   在 queryEngine push tool message 时再过一层。两层不冲突——
 *   trimOutput 是 LocalTool 单工具上限，wrapToolResult 是统一兜底（覆盖
 *   未走 LocalTool 的工具：subagent / MCP / 自定义注册的 tool）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SUMMARY_BUDGET = 4 * 1024;
const SUMMARY_HEAD = 2 * 1024;
const SUMMARY_TAIL = 2 * 1024;

export interface ToolResultEnvelope {
  /** 进 messages 的内容；保证 ≤ SUMMARY_BUDGET + hint 长度。 */
  summary: string;
  /** 全文落盘路径（仅当原文超 budget 时存在）。 */
  artifactPath?: string;
  /** 原文 byte 数；省略中段大小用于 LLM 判断要不要 read_artifact。 */
  truncatedBytes?: number;
}

export interface WrapToolResultOptions {
  /** 自定义 artifacts 根目录，主要给测试用。默认 ~/.codeclaw/artifacts。 */
  artifactsRoot?: string;
}

export function wrapToolResult(
  raw: string,
  sessionId: string,
  toolCallId: string,
  options: WrapToolResultOptions = {}
): ToolResultEnvelope {
  if (Buffer.byteLength(raw, "utf8") <= SUMMARY_BUDGET) {
    return { summary: raw };
  }
  const artifactPath = saveArtifact(sessionId, toolCallId, raw, options.artifactsRoot);
  const head = raw.slice(0, SUMMARY_HEAD);
  const tail = raw.slice(-SUMMARY_TAIL);
  const totalBytes = Buffer.byteLength(raw, "utf8");
  const omittedBytes =
    totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  const summary = [
    head,
    "",
    `... [TRUNCATED ~${omittedBytes} bytes; full output saved to ${artifactPath};`,
    `    use read_artifact(path="${artifactPath}", offset=N, limit=M) to fetch any range] ...`,
    "",
    tail,
  ].join("\n");
  return { summary, artifactPath, truncatedBytes: totalBytes };
}

function saveArtifact(
  sessionId: string,
  toolCallId: string,
  raw: string,
  artifactsRoot?: string
): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "anon";
  const safeId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
  const root = artifactsRoot ?? defaultArtifactsRoot();
  const dir = path.join(root, safeSession);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeId}.txt`);
  writeFileSync(file, raw, "utf8");
  return file;
}

export function defaultArtifactsRoot(): string {
  return path.join(os.homedir(), ".codeclaw", "artifacts");
}

export interface ReadArtifactOptions {
  offset?: number;
  limit?: number;
  /** path-traversal 防御的 root；默认 ~/.codeclaw/artifacts。测试用。 */
  artifactsRoot?: string;
}

const READ_ARTIFACT_DEFAULT_LIMIT = 16 * 1024;

/**
 * 给 read_artifact 工具用：从已保存的 artifact 取一段。
 * 严格限制只能读 artifactsRoot 下的文件，避免被滥用读任意 file。
 */
export function readArtifact(p: string, opts: ReadArtifactOptions = {}): string {
  const root = path.resolve(opts.artifactsRoot ?? defaultArtifactsRoot());
  const target = path.resolve(p);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`refuse to read outside artifacts dir: ${target}`);
  }
  if (!existsSync(target)) {
    throw new Error(`artifact not found: ${target}`);
  }
  const content = readFileSync(target, "utf8");
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? READ_ARTIFACT_DEFAULT_LIMIT);
  return content.slice(offset, offset + limit);
}
