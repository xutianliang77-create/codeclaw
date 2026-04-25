/**
 * Golden Set · /fix scorer
 *
 * 提供：
 *   - runShell：在指定 cwd 执行 shell 命令并捕获 stdout/stderr/exitCode
 *   - assertVerifyBroken：跑 setup.verify_broken；exitCode==0 即「初始 bug 存在」
 *   - assertPostVerify：跑 expected.post_verify；exitCode==0 即修复成功
 *   - inspectDiffScope：基于 git diff 检查 max_files / max_lines / allow_paths / forbidden_changes
 *
 * 不依赖 LLM；不假设 workspace 是 git repo（可临时 init）。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { FixTask } from "./fix-types";

/**
 * 迷你 glob 匹配；支持 ** / * / ? 与字面量。
 *   src 下 / ** / *.ts  →  匹配 src/ 下任意深度的 .ts（含直接子文件）
 *   test/**             →  匹配 test/ 下任意路径
 *   app.py              →  精确
 *   *.json              →  顶层 .json
 *   test_*.py           →  顶层 test_*.py
 * 不支持 brace expansion / negation；fix task.yaml 现有规则范围足够覆盖。
 *
 * 算法：先占位（避免后续替换吞掉）→ escape 普通正则字符 → 还原占位为正则片段。
 *   /**\/  → /(?:.*\/)?  ：中间 ** 段允许零层目录（minimatch 兼容）
 *   **    → .*           ：开头/结尾的 **
 *   *     → [^/]*        ：单星不跨 /
 *   ?     → [^/]
 */
export function globMatch(filePath: string, pattern: string): boolean {
  const PH_DSTAR_SLASH = "DSS";
  const PH_DSTAR = "DS";
  const PH_STAR = "S";
  const PH_QM = "Q";

  let s = pattern
    .replace(/\/\*\*\//g, PH_DSTAR_SLASH)
    .replace(/\*\*/g, PH_DSTAR)
    .replace(/\*/g, PH_STAR)
    .replace(/\?/g, PH_QM);

  s = s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

  s = s
    .replace(new RegExp(PH_DSTAR_SLASH, "g"), "/(?:.*/)?")
    .replace(new RegExp(PH_DSTAR, "g"), ".*")
    .replace(new RegExp(PH_STAR, "g"), "[^/]*")
    .replace(new RegExp(PH_QM, "g"), "[^/]");

  return new RegExp(`^${s}$`).test(filePath);
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface DiffScopeReport {
  /** 命中 diff_scope 全部约束 */
  ok: boolean;
  changedFiles: number;
  changedLines: number;
  /** 与 allow_paths 不匹配的文件 */
  outsideAllowed: string[];
  /** 命中 forbidden_changes 的文件 */
  forbiddenHit: string[];
  exceedMaxFiles: boolean;
  exceedMaxLines: boolean;
}

export function runShell(
  cmd: string,
  cwd: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): ShellResult {
  const start = Date.now();
  const r = spawnSync("bash", ["-lc", cmd], {
    cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 5 * 60_000,
    env: { ...process.env, ...opts.env },
    maxBuffer: 50 * 1024 * 1024,
  });
  const durationMs = Date.now() - start;
  const exitCode = r.status ?? (r.signal ? -1 : 0);
  return {
    exitCode,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    durationMs,
  };
}

export function assertVerifyBroken(task: FixTask): { ok: boolean; detail: string; durationMs: number } {
  if (!task.absoluteWorkspace) return { ok: false, detail: "no workspace path", durationMs: 0 };
  const r = runShell(task.setup.verify_broken, task.absoluteWorkspace);
  return {
    ok: r.exitCode === 0,
    detail:
      r.exitCode === 0
        ? "verify_broken matched (bug present)"
        : `verify_broken did not match (exit=${r.exitCode}); stderr=${r.stderr.slice(0, 200)}`,
    durationMs: r.durationMs,
  };
}

export function assertPostVerify(task: FixTask): { ok: boolean; detail: string; durationMs: number } {
  if (!task.absoluteWorkspace) return { ok: false, detail: "no workspace path", durationMs: 0 };
  const r = runShell(task.expected.post_verify, task.absoluteWorkspace);
  return {
    ok: r.exitCode === 0,
    detail: r.exitCode === 0 ? "post_verify passed" : `post_verify failed (exit=${r.exitCode})`,
    durationMs: r.durationMs,
  };
}

/**
 * 从 git diff（相对 baseRef）提取 diff scope；workspace 不是 git 仓库时报错。
 * baseRef 不传 → diff 工作树相对 HEAD（通常用法）；传 "" → 与 working tree 比较 staged。
 */
export function inspectDiffScope(
  task: FixTask,
  workspace: string,
  baseRef = "HEAD"
): DiffScopeReport {
  const allowPaths = task.expected.diff_scope.allow_paths;
  const maxFiles = task.expected.diff_scope.max_files;
  const maxLines = task.expected.diff_scope.max_lines;
  const forbidden = task.expected.forbidden_changes;

  // 获取 numstat 列表
  const r = runShell(`git diff --numstat ${baseRef}`, workspace);
  if (r.exitCode !== 0) {
    return {
      ok: false,
      changedFiles: 0,
      changedLines: 0,
      outsideAllowed: [],
      forbiddenHit: [],
      exceedMaxFiles: false,
      exceedMaxLines: false,
    };
  }

  const lines = r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  let changedFiles = 0;
  let changedLines = 0;
  const outsideAllowed: string[] = [];
  const forbiddenHit: string[] = [];

  for (const line of lines) {
    // numstat: "<add>\t<del>\t<path>"；二进制 "-\t-\t<path>" 跳过 line 计数
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const adds = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
    const dels = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
    const filePath = parts.slice(2).join(" ");
    changedFiles += 1;
    changedLines += adds + dels;

    if (allowPaths.length > 0 && !allowPaths.some((g) => globMatch(filePath, g))) {
      outsideAllowed.push(filePath);
    }
    if (forbidden.some((g) => globMatch(filePath, g))) {
      forbiddenHit.push(filePath);
    }
  }

  const exceedMaxFiles = changedFiles > maxFiles;
  const exceedMaxLines = changedLines > maxLines;
  const ok =
    !exceedMaxFiles &&
    !exceedMaxLines &&
    outsideAllowed.length === 0 &&
    forbiddenHit.length === 0;

  return {
    ok,
    changedFiles,
    changedLines,
    outsideAllowed,
    forbiddenHit,
    exceedMaxFiles,
    exceedMaxLines,
  };
}

/** 浅检查 workspace 是否含 .git 目录 / 是否需 git init */
export function isGitRepo(workspace: string): boolean {
  return existsSync(path.join(workspace, ".git"));
}
