/**
 * Skill banner 重注入（M3-03）
 *
 * 问题：skill 完整 prompt 一次性拼进 system prompt（M1-A）；多轮对话深处 LLM
 * 容易"忘记"约束，回到默认行为模式（用了禁用工具 / 越界写文件）。
 *
 * 方案：每个 LLM turn 派发前，给最近一条 role:"user" 消息加一行简短 banner：
 *   [Active skill: <name>] <description>
 *
 * 不重复完整 skill.prompt 是为了省 token；只是 reminder 让模型 attend。
 *
 * 不变量：
 *   - 只在拷贝上 mutate；调用方 messages 数组本身不动
 *   - 找最后一条 role==="user"（multi-turn 中也只有一条来自用户的消息，
 *     intermediate role:"tool" / role:"assistant" 不动）
 *   - skill 不存在或没 user message → 原样返回
 */

import type { SkillDefinition } from "../skills/types";
import type { EngineMessage } from "./types";

export function applySkillBanner(
  messages: EngineMessage[],
  skill: SkillDefinition | null
): EngineMessage[] {
  if (!skill) return messages;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return messages;
  const banner = formatSkillBanner(skill);
  const orig = messages[lastUserIdx];
  const decorated: EngineMessage = { ...orig, text: `${banner}\n\n${orig.text}` };
  const out = messages.slice();
  out[lastUserIdx] = decorated;
  return out;
}

export function formatSkillBanner(skill: SkillDefinition): string {
  return `[Active skill: ${skill.name}] ${skill.description}`;
}
