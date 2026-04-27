/**
 * /cron 命令参数解析（#116 step C.4）
 *
 * 单独抽出便于测试。支持：
 *   list / add / remove / enable / disable / run-now / logs
 *
 * 简易 tokenize：支持双引号包裹的多 token 字段（schedule / payload / name）。
 */

import type { CronNotifyChannel, CronTaskKind } from "./types";

export type CronCliCommand =
  | { kind: "list" }
  | {
      kind: "add";
      name: string;
      schedule: string;
      taskKind: CronTaskKind;
      payload: string;
      notify: CronNotifyChannel[];
      timeoutMs?: number;
    }
  | { kind: "remove"; target: string }
  | { kind: "enable"; target: string }
  | { kind: "disable"; target: string }
  | { kind: "run-now"; target: string }
  | { kind: "logs"; target: string; tail: number }
  | { kind: "template-list" }
  | { kind: "template-add"; templateKey: string; name?: string }
  | { kind: "help" };

const HELP = "help";

export function parseCronArgs(argsRaw: string): CronCliCommand {
  const trimmed = argsRaw.trim();
  if (!trimmed || trimmed === "list") return { kind: "list" };

  const tokens = tokenize(trimmed);
  const sub = tokens.shift()?.toLowerCase();

  switch (sub) {
    case undefined:
    case "":
    case "list":
      return { kind: "list" };
    case "remove":
    case "rm":
      return requireTarget("remove", tokens);
    case "enable":
      return requireTarget("enable", tokens);
    case "disable":
      return requireTarget("disable", tokens);
    case "run-now":
    case "run":
      return requireTarget("run-now", tokens);
    case "logs":
    case "log":
      return parseLogs(tokens);
    case "add":
      return parseAdd(tokens);
    case "template":
    case "templates":
    case "tpl":
      return parseTemplate(tokens);
    case HELP:
      return { kind: "help" };
    default:
      throw new Error(`unknown /cron subcommand: ${sub}`);
  }
}

function parseTemplate(tokens: string[]): CronCliCommand {
  const sub = tokens.shift()?.toLowerCase();
  if (!sub || sub === "list" || sub === "ls") return { kind: "template-list" };
  if (sub === "add") {
    const key = tokens[0];
    const name = tokens[1];
    if (!key) throw new Error("/cron template add requires <template-key> [name]");
    return { kind: "template-add", templateKey: key, ...(name ? { name } : {}) };
  }
  throw new Error(`unknown /cron template subcommand: ${sub}`);
}

function requireTarget(
  kind: "remove" | "enable" | "disable" | "run-now",
  tokens: string[]
): CronCliCommand {
  const target = tokens[0];
  if (!target) throw new Error(`/cron ${kind} requires a task id or name`);
  return { kind, target };
}

function parseLogs(tokens: string[]): CronCliCommand {
  const target = tokens[0];
  if (!target) throw new Error("/cron logs requires a task id or name");
  let tail = 20;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--tail=")) {
      const n = Number.parseInt(t.slice("--tail=".length), 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --tail: ${t}`);
      tail = n;
    } else if (t === "--tail") {
      const n = Number.parseInt(tokens[++i] ?? "", 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error("--tail requires a positive integer");
      tail = n;
    } else {
      throw new Error(`unknown logs option: ${t}`);
    }
  }
  return { kind: "logs", target, tail };
}

/**
 * `/cron add <name> <schedule> <kind>:<payload> [--notify=cli,wechat] [--timeout=Nms]`
 *
 * 字段说明：
 *   - name / schedule 可加引号
 *   - "kind:payload"：第一段 `slash|prompt|shell` 后接 `:`，余下整段视为 payload
 *     (允许 payload 内含空格，引号包裹 or 把 kind:payload 整体引号包裹)
 *   - 多 --notify 累加；--timeout 单次
 */
function parseAdd(tokens: string[]): CronCliCommand {
  // P4.4：检测 flag 形式（--name= / --schedule= / --kind= / --payload=）
  // flag 形式与位置参数互斥，混用 reject。
  const coreFieldFlags = ["--name=", "--schedule=", "--kind=", "--payload="];
  const hasCoreFlag = tokens.some((t) =>
    coreFieldFlags.some((prefix) => t.startsWith(prefix))
  );
  if (hasCoreFlag) {
    return parseAddFlagForm(tokens);
  }

  const positional: string[] = [];
  const flags: string[] = [];
  for (const t of tokens) {
    if (t.startsWith("--")) flags.push(t);
    else positional.push(t);
  }
  if (positional.length < 3) {
    throw new Error(
      "/cron add requires: <name> <schedule> <kind>:<payload> [--notify=...] [--timeout=Nms]\n" +
        "或使用 flag 形式：--name=... --schedule=... --kind=... --payload=... [--notify=...] [--timeout=...]"
    );
  }
  const name = positional[0];
  const schedule = positional[1];
  const kindPayload = positional.slice(2).join(" ");
  const colonIdx = kindPayload.indexOf(":");
  if (colonIdx < 1) {
    throw new Error(`/cron add: expected '<kind>:<payload>', got '${kindPayload}'`);
  }
  const kindStr = kindPayload.slice(0, colonIdx).toLowerCase();
  const payload = kindPayload.slice(colonIdx + 1).trim();
  if (kindStr !== "slash" && kindStr !== "prompt" && kindStr !== "shell") {
    throw new Error(`/cron add: kind must be slash|prompt|shell, got '${kindStr}'`);
  }
  if (!payload) throw new Error(`/cron add: payload is empty`);

  const { notify, timeoutMs } = parseAddTrailingFlags(flags);

  return {
    kind: "add",
    name,
    schedule,
    taskKind: kindStr as CronTaskKind,
    payload,
    notify,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/** P4.4：flag 形式 /cron add --name=... --schedule=... --kind=... --payload=... [--notify=] [--timeout=] */
function parseAddFlagForm(tokens: string[]): CronCliCommand {
  let name: string | undefined;
  let schedule: string | undefined;
  let kindStr: string | undefined;
  let payload: string | undefined;
  const trailing: string[] = []; // --notify / --timeout 等

  for (const t of tokens) {
    if (!t.startsWith("--")) {
      throw new Error(
        `/cron add: flag form does not accept positional args (got '${t}'). 不要混用位置参数和 flag。`
      );
    }
    if (t.startsWith("--name=")) name = t.slice("--name=".length);
    else if (t.startsWith("--schedule=")) schedule = t.slice("--schedule=".length);
    else if (t.startsWith("--kind=")) kindStr = t.slice("--kind=".length).toLowerCase();
    else if (t.startsWith("--payload=")) payload = t.slice("--payload=".length);
    else trailing.push(t);
  }

  if (!name) throw new Error("/cron add: --name=... is required");
  if (!schedule) throw new Error("/cron add: --schedule=... is required");
  if (!kindStr) throw new Error("/cron add: --kind=... is required");
  if (payload === undefined) throw new Error("/cron add: --payload=... is required");

  if (kindStr !== "slash" && kindStr !== "prompt" && kindStr !== "shell") {
    throw new Error(`/cron add: kind must be slash|prompt|shell, got '${kindStr}'`);
  }
  if (!payload.trim()) throw new Error("/cron add: payload is empty");

  const { notify, timeoutMs } = parseAddTrailingFlags(trailing);

  return {
    kind: "add",
    name,
    schedule,
    taskKind: kindStr as CronTaskKind,
    payload,
    notify,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/** 解析 --notify / --timeout 这类 trailing flags（位置和 flag 形式共用） */
function parseAddTrailingFlags(flags: string[]): {
  notify: CronNotifyChannel[];
  timeoutMs?: number;
} {
  const notify: CronNotifyChannel[] = [];
  let timeoutMs: number | undefined;
  for (const f of flags) {
    if (f.startsWith("--notify=")) {
      const list = f.slice("--notify=".length).split(",");
      for (const ch of list) {
        const v = ch.trim().toLowerCase();
        if (v === "cli" || v === "wechat" || v === "web") {
          if (!notify.includes(v)) notify.push(v);
        } else if (v) {
          throw new Error(`/cron add: unknown notify channel '${v}'`);
        }
      }
    } else if (f.startsWith("--timeout=")) {
      const raw = f.slice("--timeout=".length);
      const ms = parseDurationToMs(raw);
      if (!ms) throw new Error(`/cron add: invalid --timeout '${raw}'`);
      timeoutMs = ms;
    } else {
      throw new Error(`/cron add: unknown flag ${f}`);
    }
  }
  return timeoutMs !== undefined ? { notify, timeoutMs } : { notify };
}

function parseDurationToMs(raw: string): number | null {
  const m = raw.match(/^(\d+)(ms|s|m|h)?$/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  const unit = m[2] ?? "ms";
  if (n <= 0) return null;
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return n * mult;
}

/**
 * 简易 tokenizer：按空格切；支持 "..." 'doulbe quote'，反斜杠转义；
 * 不支持嵌套 / shell 语法。
 */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inDouble && !inSingle && /\s/.test(c)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
