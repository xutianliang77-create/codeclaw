/**
 * Skill SDK · loader · #71
 *
 * 从 ~/.codeclaw/skills/<name>/manifest.yaml 同步加载用户自定义 skill。
 * 不存在该目录 / 解析失败 / 校验失败 → 收集 errors 但不抛（避免单坏 manifest 阻塞启动）；
 * 调用方可拿 LoadResult.errors 决定是否打日志 / doctor 显示。
 *
 * 设计：
 *   - 同步 fs（loader 在启动 hot path 上，目录条目少）
 *   - YAML via js-yaml（已是项目依赖）
 *   - allowedTools 必须全部在 LocalToolName 白名单内
 *   - 与 builtin 重名直接拒（避免覆盖 / 提权风险）
 *   - signature 字段被解析但 P1 不验证（占位字段）
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import type { SkillDefinition, SkillManifest, SkillSignature, SkillSlashCommand } from "./types";

// 注意：与 registry.ts BUILTIN_NAMES 同步（不能让 user skill 覆盖）
const VALID_TOOLS = new Set([
  "read",
  "glob",
  "symbol",
  "definition",
  "references",
  "bash",
  "write",
  "append",
  "replace",
]);

// T6 防御：限制 user skill 的 prompt / description 长度，防 mega-prompt 注入
const MAX_PROMPT_LEN = 8000;
const MAX_DESCRIPTION_LEN = 500;
// 控制字符（ANSI / NULL / 其他不可见）—— 阻止显示层欺骗
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export interface LoadResult {
  skills: SkillDefinition[];
  errors: Array<{ path: string; reason: string }>;
}

export function defaultUserSkillsDir(): string {
  return path.join(os.homedir(), ".codeclaw", "skills");
}

/**
 * 扫 skillsDir，每个子目录读 manifest.yaml，解析 + 校验。
 * builtinNames 用来防与 builtin 重名。
 */
export function loadUserSkillsFromDir(
  skillsDir: string,
  builtinNames: Set<string>
): LoadResult {
  const result: LoadResult = { skills: [], errors: [] };
  if (!existsSync(skillsDir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch (err) {
    result.errors.push({
      path: skillsDir,
      reason: `cannot read dir: ${err instanceof Error ? err.message : String(err)}`,
    });
    return result;
  }

  for (const entry of entries) {
    const subdir = path.join(skillsDir, entry);
    let st;
    try {
      st = statSync(subdir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const manifestPath = path.join(subdir, "manifest.yaml");
    if (!existsSync(manifestPath)) continue;

    let raw: string;
    try {
      raw = readFileSync(manifestPath, "utf8");
    } catch (err) {
      result.errors.push({
        path: manifestPath,
        reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      result.errors.push({
        path: manifestPath,
        reason: `yaml parse failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const validation = validateManifest(parsed, builtinNames);
    if (!validation.ok) {
      result.errors.push({ path: manifestPath, reason: validation.reason });
      continue;
    }

    const skill: SkillDefinition = {
      name: validation.manifest.name,
      description: validation.manifest.description,
      prompt: validation.manifest.prompt,
      allowedTools: validation.manifest.allowedTools,
      source: validation.manifest.signature ? "signed" : "user",
      manifestPath,
      signature: validation.manifest.signature,
      commands: validation.manifest.commands,
    };
    result.skills.push(skill);
  }

  // 同名 user skill 互相冲突也要拒（保留先扫到的）
  const seen = new Set<string>();
  result.skills = result.skills.filter((s) => {
    if (seen.has(s.name)) {
      result.errors.push({
        path: s.manifestPath ?? "",
        reason: `duplicate user skill name "${s.name}"; ignoring`,
      });
      return false;
    }
    seen.add(s.name);
    return true;
  });

  return result;
}

interface ValidationOk {
  ok: true;
  manifest: SkillManifest;
}
interface ValidationFail {
  ok: false;
  reason: string;
}

export function validateManifest(
  input: unknown,
  builtinNames: Set<string>
): ValidationOk | ValidationFail {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "manifest root must be an object" };
  }
  const obj = input as Record<string, unknown>;

  const name = obj.name;
  if (typeof name !== "string" || !/^[a-z][a-z0-9_-]{1,40}$/i.test(name)) {
    return {
      ok: false,
      reason: `name must match /^[a-z][a-z0-9_-]{1,40}$/i (got ${JSON.stringify(name)})`,
    };
  }
  if (builtinNames.has(name.toLowerCase())) {
    return { ok: false, reason: `name "${name}" collides with builtin skill` };
  }

  const description = obj.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    return { ok: false, reason: "description required (string, non-empty)" };
  }
  if (description.length > MAX_DESCRIPTION_LEN) {
    return { ok: false, reason: `description too long (>${MAX_DESCRIPTION_LEN} chars)` };
  }
  if (FORBIDDEN_CONTROL_CHARS.test(description)) {
    return { ok: false, reason: "description contains forbidden control characters (T6 defense)" };
  }

  const prompt = obj.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return { ok: false, reason: "prompt required (string, non-empty)" };
  }
  if (prompt.length > MAX_PROMPT_LEN) {
    return { ok: false, reason: `prompt too long (>${MAX_PROMPT_LEN} chars)` };
  }
  if (FORBIDDEN_CONTROL_CHARS.test(prompt)) {
    return { ok: false, reason: "prompt contains forbidden control characters (T6 defense)" };
  }

  const allowedTools = obj.allowedTools;
  if (!Array.isArray(allowedTools) || allowedTools.length === 0) {
    return { ok: false, reason: "allowedTools required (non-empty string[])" };
  }
  for (const t of allowedTools) {
    if (typeof t !== "string" || !VALID_TOOLS.has(t)) {
      return {
        ok: false,
        reason: `allowedTools contains invalid tool ${JSON.stringify(t)} (allowed: ${[...VALID_TOOLS].join(",")})`,
      };
    }
  }

  const version = obj.version;
  if (version !== undefined && (typeof version !== "number" || version < 1)) {
    return { ok: false, reason: "version must be number >= 1 if present" };
  }

  const author = obj.author;
  if (author !== undefined && typeof author !== "string") {
    return { ok: false, reason: "author must be string if present" };
  }

  let commands: SkillSlashCommand[] | undefined;
  if (obj.commands !== undefined) {
    if (!Array.isArray(obj.commands)) {
      return { ok: false, reason: "commands must be array if present" };
    }
    const list: SkillSlashCommand[] = [];
    for (const raw of obj.commands) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, reason: "each commands[] item must be object" };
      }
      const cmd = raw as Record<string, unknown>;
      if (typeof cmd.name !== "string" || !/^\/[a-z][a-z0-9_-]{0,30}$/i.test(cmd.name)) {
        return {
          ok: false,
          reason: `command.name must match /^\\/[a-z][a-z0-9_-]{0,30}$/ (got ${JSON.stringify(cmd.name)})`,
        };
      }
      list.push({
        name: cmd.name.toLowerCase(),
        summary: typeof cmd.summary === "string" ? cmd.summary : undefined,
      });
    }
    if (list.length > 0) commands = list;
  }

  let signature: SkillSignature | undefined;
  if (obj.signature !== undefined) {
    if (!obj.signature || typeof obj.signature !== "object" || Array.isArray(obj.signature)) {
      return { ok: false, reason: "signature must be object if present" };
    }
    const sig = obj.signature as Record<string, unknown>;
    signature = {
      algo: typeof sig.algo === "string" ? sig.algo : undefined,
      publicKey: typeof sig.publicKey === "string" ? sig.publicKey : undefined,
      value: typeof sig.value === "string" ? sig.value : undefined,
    };
    // P1 仅占位：要求齐三件才认作签名（防误用）；P2 真做 ed25519 验证
    if (!signature.algo || !signature.publicKey || !signature.value) {
      return {
        ok: false,
        reason: "signature must include algo + publicKey + value when present",
      };
    }
  }

  return {
    ok: true,
    manifest: {
      name,
      description,
      prompt,
      allowedTools: allowedTools as SkillManifest["allowedTools"],
      version: typeof version === "number" ? version : undefined,
      author: typeof author === "string" ? author : undefined,
      signature,
      commands,
    },
  };
}
