/**
 * Skill SDK · 类型定义 · #71
 *
 * SkillManifest = 用户在 ~/.codeclaw/skills/<name>/manifest.yaml 写的描述
 * SkillDefinition = registry 内部消费的格式（含 source 标记 + 校验后的字段）
 */

import type { LocalToolName } from "../tools/local";

export type SkillSource = "builtin" | "user" | "signed";

export interface SkillSignature {
  /** 暂只占位；P2 真做 ed25519 验证 */
  algo?: string;
  publicKey?: string;
  value?: string;
}

/** 磁盘上的 manifest.yaml 解析后的形态（loader 入口） */
export interface SkillManifest {
  /** 全局唯一名（loader 校验不能与 builtin 同名） */
  name: string;
  /** 一句话描述 */
  description: string;
  /** system prompt 注入：激活 skill 时附加给模型 */
  prompt: string;
  /** 允许该 skill 调用的工具白名单 */
  allowedTools: LocalToolName[];
  /** 可选 manifest 版本（兼容性，目前固定 1） */
  version?: number;
  /** 可选作者 / 描述维护者 */
  author?: string;
  /** P2 预留：签名信息（loader 解析但不校验） */
  signature?: SkillSignature;
  /**
   * #81：用户 skill 自定义 slash 命令；激活时 handler 等价于 /skills use <skill-name>
   * 每条 name 必须以 / 开头；不能与 builtin slash 命令重名（loader 校验）
   */
  commands?: SkillSlashCommand[];
}

export interface SkillSlashCommand {
  /** 含 / 前缀，例：/review-mode */
  name: string;
  /** 一行 summary（用于 /help） */
  summary?: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  allowedTools: LocalToolName[];
  source: SkillSource;
  /** user / signed 类才有；指向 manifest 文件以便诊断显示 */
  manifestPath?: string;
  signature?: SkillSignature;
  /** #81：从 manifest commands[] 解析的 slash 命令名（含 /） */
  commands?: SkillSlashCommand[];
}
