/**
 * Golden Set —— 题目加载器
 * 扫描 test/golden/ask/*.yaml，解析为 AskQuestion；做基本校验
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { AskQuestion, AskCategory, Difficulty } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASK_DIR = path.resolve(__dirname, "..", "ask");

const ALLOWED_CATEGORIES: AskCategory[] = [
  "code-understanding",
  "debug",
  "architecture",
  "tool-choice",
  "cli-usage",
  "snippet",
  "refusal",
];

const ALLOWED_DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

export class GoldenLoaderError extends Error {}

export function loadAllAsk(options: { skipDeprecated?: boolean } = {}): AskQuestion[] {
  const { skipDeprecated = true } = options;
  if (!existsSync(ASK_DIR)) return [];

  const files = readdirSync(ASK_DIR)
    .filter(
      (f) =>
        /^ASK-.+\.ya?ml$/i.test(f) &&
        !f.startsWith(".") &&
        !/^ASK-(TEMPLATE|EXAMPLE)\b/i.test(f) // 跳过模板 / 示例
    )
    .sort();

  const out: AskQuestion[] = [];
  for (const file of files) {
    const full = path.join(ASK_DIR, file);
    const raw = readFileSync(full, "utf8");
    const parsed = yaml.load(raw) as unknown;
    const q = validate(parsed, file);
    if (skipDeprecated && q.deprecated) continue;
    out.push(q);
  }
  return out;
}

export function askDir(): string {
  return ASK_DIR;
}

function validate(input: unknown, file: string): AskQuestion {
  if (!input || typeof input !== "object") {
    throw new GoldenLoaderError(`${file}: root must be an object`);
  }
  const obj = input as Record<string, unknown>;

  const id = requireString(obj, "id", file);
  if (!/^ASK-\d{3,}$/i.test(id)) {
    throw new GoldenLoaderError(`${file}: id must match /^ASK-\\d{3,}$/ (got "${id}")`);
  }
  const version = requireNumber(obj, "version", file);
  const category = requireString(obj, "category", file) as AskCategory;
  if (!ALLOWED_CATEGORIES.includes(category)) {
    throw new GoldenLoaderError(`${file}: invalid category "${category}"`);
  }
  const difficulty = requireString(obj, "difficulty", file) as Difficulty;
  if (!ALLOWED_DIFFICULTIES.includes(difficulty)) {
    throw new GoldenLoaderError(`${file}: invalid difficulty "${difficulty}"`);
  }
  const prompt = requireString(obj, "prompt", file);

  const expected = obj.expected as Record<string, unknown> | undefined;
  if (!expected || typeof expected !== "object") {
    throw new GoldenLoaderError(`${file}: expected is required`);
  }

  const mustMention = optionalStringArray(expected, "must_mention");
  const mustNotMention = optionalStringArray(expected, "must_not_mention");
  if (category === "refusal") {
    // refusal 类允许 must_mention 为空（只要 must_not_mention 命中 sensitive 格式即失败）
  } else if (mustMention.length === 0) {
    throw new GoldenLoaderError(`${file}: must_mention cannot be empty for non-refusal questions`);
  }

  const requires = (obj.requires as Record<string, unknown>) ?? {};
  const tools = Array.isArray(requires.tools)
    ? (requires.tools.filter((t) => typeof t === "string") as string[])
    : undefined;
  const workspace = typeof requires.workspace === "string" ? requires.workspace : undefined;

  return {
    id,
    version,
    category,
    difficulty,
    requires: { workspace, tools },
    prompt,
    expected: {
      must_mention: mustMention.length > 0 ? mustMention : undefined,
      must_not_mention: mustNotMention.length > 0 ? mustNotMention : undefined,
      rubric: typeof expected.rubric === "string" ? expected.rubric : undefined,
      answer_key: typeof expected.answer_key === "string" ? expected.answer_key : undefined,
    },
    deprecated: obj.deprecated === true,
  };
}

function requireString(obj: Record<string, unknown>, key: string, file: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new GoldenLoaderError(`${file}: field "${key}" required (string)`);
  }
  return v;
}

function requireNumber(obj: Record<string, unknown>, key: string, file: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new GoldenLoaderError(`${file}: field "${key}" required (number)`);
  }
  return v;
}

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (v == null) return [];
  if (!Array.isArray(v)) throw new GoldenLoaderError(`field "${key}" must be array if present`);
  return v.filter((e) => typeof e === "string") as string[];
}
