/**
 * Golden Set · /fix 加载器
 *
 * 扫描 test/golden/fix/<id>/task.yaml，解析为 FixTask 并校验。
 *   - 每个 fixture 必须含 task.yaml + workspace/ 目录
 *   - id 格式 /^FIX-\d{2,3}$/
 *   - workspace 字段必须是相对 repo 根的真实存在目录
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import type { FixTask, FixDifficulty } from "./fix-types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.resolve(__dirname, "..", "fix");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const ALLOWED_DIFFICULTIES: FixDifficulty[] = ["easy", "medium", "hard"];

export class FixLoaderError extends Error {}

export function fixDir(): string {
  return FIX_DIR;
}

export function loadAllFix(): FixTask[] {
  if (!existsSync(FIX_DIR)) return [];

  const entries = readdirSync(FIX_DIR)
    .filter((name) => /^FIX-\d{2,3}$/i.test(name))
    .sort();

  const out: FixTask[] = [];
  for (const id of entries) {
    const taskPath = path.join(FIX_DIR, id, "task.yaml");
    if (!existsSync(taskPath)) {
      // 跳过 fixture 目录但缺 task.yaml 的（避免 placeholder 污染）
      continue;
    }
    const raw = readFileSync(taskPath, "utf8");
    const parsed = yaml.load(raw) as unknown;
    out.push(validate(parsed, taskPath));
  }
  return out;
}

function validate(input: unknown, taskFile: string): FixTask {
  if (!input || typeof input !== "object") {
    throw new FixLoaderError(`${taskFile}: root must be an object`);
  }
  const obj = input as Record<string, unknown>;

  const id = requireString(obj, "id", taskFile);
  if (!/^FIX-\d{2,3}$/i.test(id)) {
    throw new FixLoaderError(`${taskFile}: id must match /^FIX-\\d{2,3}$/ (got "${id}")`);
  }
  const version = requireNumber(obj, "version", taskFile);
  const language = requireString(obj, "language", taskFile);
  const workspace = requireString(obj, "workspace", taskFile);
  const prompt = requireString(obj, "prompt", taskFile);
  const category = requireString(obj, "category", taskFile);
  const difficulty = requireString(obj, "difficulty", taskFile) as FixDifficulty;
  if (!ALLOWED_DIFFICULTIES.includes(difficulty)) {
    throw new FixLoaderError(`${taskFile}: invalid difficulty "${difficulty}"`);
  }

  const setup = requireObject(obj, "setup", taskFile);
  const setupInstall = requireString(setup, "install", taskFile);
  const setupVerifyBroken = requireString(setup, "verify_broken", taskFile);

  const expected = requireObject(obj, "expected", taskFile);
  const postVerify = requireString(expected, "post_verify", taskFile);
  const diffScope = requireObject(expected, "diff_scope", taskFile);
  const allowPaths = requireStringArray(diffScope, "allow_paths", taskFile);
  const maxFiles = requireNumber(diffScope, "max_files", taskFile);
  const maxLines = requireNumber(diffScope, "max_lines", taskFile);
  const forbidden = optionalStringArray(expected, "forbidden_changes");
  const timeBudgetSec = requireNumber(expected, "time_budget_sec", taskFile);
  const tokenBudgetUsd = requireNumber(expected, "token_budget_usd", taskFile);

  const absoluteWorkspace = path.resolve(REPO_ROOT, workspace);
  if (!existsSync(absoluteWorkspace) || !statSync(absoluteWorkspace).isDirectory()) {
    throw new FixLoaderError(
      `${taskFile}: workspace "${workspace}" does not exist or is not a directory`
    );
  }

  return {
    id,
    version,
    language,
    workspace,
    setup: {
      install: setupInstall,
      verify_broken: setupVerifyBroken,
    },
    prompt,
    expected: {
      post_verify: postVerify,
      diff_scope: { allow_paths: allowPaths, max_files: maxFiles, max_lines: maxLines },
      forbidden_changes: forbidden,
      time_budget_sec: timeBudgetSec,
      token_budget_usd: tokenBudgetUsd,
    },
    category,
    difficulty,
    absoluteWorkspace,
    taskFile,
  };
}

function requireString(obj: Record<string, unknown>, key: string, file: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new FixLoaderError(`${file}: field "${key}" required (string)`);
  }
  return v;
}

function requireNumber(obj: Record<string, unknown>, key: string, file: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new FixLoaderError(`${file}: field "${key}" required (number)`);
  }
  return v;
}

function requireObject(obj: Record<string, unknown>, key: string, file: string): Record<string, unknown> {
  const v = obj[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new FixLoaderError(`${file}: field "${key}" required (object)`);
  }
  return v as Record<string, unknown>;
}

function requireStringArray(obj: Record<string, unknown>, key: string, file: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
    throw new FixLoaderError(`${file}: field "${key}" required (string[])`);
  }
  return v as string[];
}

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (v == null) return [];
  if (!Array.isArray(v)) return [];
  return v.filter((s) => typeof s === "string") as string[];
}
