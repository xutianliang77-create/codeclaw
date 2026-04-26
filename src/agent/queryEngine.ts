import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { clearPendingApprovals, loadPendingApprovals, savePendingApprovals } from "../approvals/store";
import type { StoredPendingApproval } from "../approvals/store";
import { runDoctor } from "../commands/doctor";
import type { PermissionMode } from "../lib/config";
import { sanitizeForDisplay } from "../lib/displaySafe";
import { callMcpTool, listMcpResources, listMcpServers, listMcpTools, readMcpResource } from "../mcp/service";
import { SlashRegistry, loadBuiltins } from "../commands/slash";
import { EngineFsm } from "../fsm";
import type { FsmSnapshot } from "../fsm";
import { openAuditDb } from "../storage/audit";
import { AuditLog } from "../storage/auditLog";
import type { AuditDecision } from "../storage/auditLog";
import { openDataDb } from "../storage/db";
import {
  forgetMemoryDigests,
  saveMemoryDigest,
  type ForgetOptions,
} from "../memory/sessionMemory/store";
import { forgetAllSessions, forgetSession } from "../storage/forget";
import { homedir } from "node:os";
import { recallRecent } from "../memory/sessionMemory/recaller";
import {
  createProviderSummarizer,
  summarizeSession,
} from "../memory/sessionMemory/summarizer";
import type Database from "better-sqlite3";
import QRCode from "qrcode";
import {
  buildApprovedExecutionPlan,
  buildGapSignature,
  buildOrchestrationPlan,
  executeOrchestrationPlan,
  reflectOnApprovalOutcome,
  reflectOnExecution
} from "../orchestration";
import type {
  CheckObservation,
  CompletionCheck,
  ExecutionResult,
  GoalDefinition,
  OrchestrationApprovalRequest,
  OrchestrationContext,
  OrchestrationPlan,
  ReflectorResult
} from "../orchestration";
import type { ExecutionAction } from "../orchestration/types";
import { PermissionManager } from "../permissions/manager";
import { ProviderRequestError, streamProviderResponse } from "../provider/client";
import type { ToolSchemaSpec } from "../provider/client";
import { runWithProviderChain, type RunChainResult } from "../provider/chain";
import { recordCall, summarizeBySession, summarizeToday, formatUsd } from "../provider/costTracker";
import { evaluateBudget, formatBudgetConfig, readBudgetFromEnv, type BudgetConfig } from "../provider/budget";
import { detectProviderCapabilities } from "../provider/capabilities";
import type { ProviderStatus } from "../provider/types";
import { createSkillRegistry, createSkillRegistryFromDisk } from "../skills/registry";
import type { SkillDefinition } from "../skills/registry";
import { buildSystemPrompt } from "./systemPrompt";
import { ToolRegistry, createToolRegistry } from "./tools/registry";
import type { ToolCallEvent } from "./tools/registry";
import { registerBuiltinTools } from "./tools/builtins";
import { registerMemoryTools } from "./tools/memoryTools";
import { clearAllMemories, writeMemory, type MemoryType } from "../memory/projectMemory/store";
import { EXIT_PLAN_SENTINEL, registerPlanModeTool } from "./tools/planMode";
import { checkTokenBudget, estimateToolsSchemaTokens, warnIfBudgetExceeded } from "./tokenBudget";
import { autoCompactIfNeeded } from "./autoCompact";
import { detectLocalTool, inspectLocalTool, isHandledLocalToolResult, runLocalTool } from "../tools/local";
import type { LocalToolName } from "../tools/local";
import type {
  ChannelSessionSnapshot,
  EngineEvent,
  EngineMessage,
  EngineImageAttachment,
  EngineMessageSource,
  PendingApprovalView,
  PendingOrchestrationApprovalView,
  QueryEngine,
  QueryEngineOptions,
  QuerySubmitOptions,
  WechatLoginStateView
} from "./types";

/**
 * M2-04：把 ToolCallEvent 映射成 PermissionManager.evaluate 的输入。
 *   - read/glob/symbol/definition/references → target=args.file_path/pattern/query
 *   - bash → command=args.command
 *   - write/append/replace → target=args.file_path
 *   - memory_write/memory_remove/ExitPlanMode → null（跳过 evaluate，自动 allow）
 *   - 未知 tool（MCP / 用户扩展）→ 当 mcp-call → evaluate 返 medium → 走 ask 路径
 */
function buildPermissionInputFromToolCall(
  call: ToolCallEvent
): import("../permissions/manager").ToolPermissionInput | null {
  const args = (call.args ?? {}) as Record<string, unknown>;
  const t = call.name;
  switch (t) {
    case "read":
    case "glob":
      return {
        tool: t,
        target: typeof args.file_path === "string" ? args.file_path : typeof args.pattern === "string" ? args.pattern : "",
      };
    case "symbol":
    case "definition":
    case "references":
      return {
        tool: t,
        target: typeof args.query === "string" ? args.query : "",
      };
    case "bash":
      return { tool: "bash", command: typeof args.command === "string" ? args.command : "" };
    case "write":
    case "append":
      return { tool: t, target: typeof args.file_path === "string" ? args.file_path : "" };
    case "replace":
      return { tool: "replace", target: typeof args.file_path === "string" ? args.file_path : "" };
    case "memory_write":
    case "memory_remove":
    case "ExitPlanMode":
      return null; // 不走 evaluate；自动 allow
    default:
      // MCP / 用户扩展 tool → 当 mcp-call medium，走 ask 路径
      return { tool: "mcp-call", server: "unknown", toolName: t };
  }
}

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 模块级兜底回复（不依赖 SlashRegistry，给"help / doctor / setup / config / /exit"
 * 这些非 slash 字面量留路径）。`/help` / `/exit` 在 queryEngine 里另外用 registry
 * + 实例方法处理。
 */
/**
 * /fix v2 的参数解析：
 *   /fix some bug                    → { goal: "some bug", verifyCmd: undefined }
 *   /fix bug -- verify "npm test"    → { goal: "bug", verifyCmd: "npm test" }
 *   /fix -- verify "npm test"        → { goal: "", verifyCmd: "npm test" }（caller 应当报 usage）
 */
function parseFixArgs(stripped: string): { goal: string; verifyCmd?: string } {
  // 先尝试匹配 "-- verify <quoted-or-bare>" 段
  const verifyRe = /\s+--\s+verify\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/;
  const match = stripped.match(verifyRe);
  if (!match) {
    return { goal: stripped };
  }
  const verifyCmd = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  const goal = stripped.slice(0, match.index).trim();
  return { goal, verifyCmd: verifyCmd || undefined };
}

/**
 * 用 shell 跑一条命令，捕获 stdout / stderr / exit code。
 * 不抛异常；timeout 后返回 ok=false。
 */
async function runShellCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(process.env.SHELL ?? "bash", ["-lc", cmd], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        stdout,
        stderr: timedOut ? `${stderr}\n[killed: timeout ${timeoutMs}ms]` : stderr,
        code,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: `${stderr}\n[spawn error] ${err.message}`, code: null });
    });
  });
}

/**
 * diff_scope 默认阈值。单 bug 修复通常 1-3 文件 / <100 行；
 * 超过即视为 LLM 越权或题目不是单 bug，让用户审视。
 */
export const DIFF_SCOPE_MAX_FILES = 5;
export const DIFF_SCOPE_MAX_LINES = 300;

/**
 * 解析 `git diff --stat` 末行 summary：
 *   "5 files changed, 200 insertions(+), 100 deletions(-)"
 *   "1 file changed, 5 insertions(+)"
 *   "1 file changed, 5 deletions(-)"
 * 找不到 summary 则返回 null（空 diff / git 不可用）。
 */
export function parseDiffStatSummary(
  stat: string
): { files: number; insertions: number; deletions: number } | null {
  const lines = stat.trim().split(/\r?\n/);
  const last = lines[lines.length - 1] ?? "";
  const fileMatch = last.match(/(\d+)\s+files?\s+changed/);
  if (!fileMatch) return null;
  const insMatch = last.match(/(\d+)\s+insertions?\(\+\)/);
  const delMatch = last.match(/(\d+)\s+deletions?\(-\)/);
  return {
    files: Number(fileMatch[1]),
    insertions: insMatch ? Number(insMatch[1]) : 0,
    deletions: delMatch ? Number(delMatch[1]) : 0,
  };
}

/**
 * 多语言 verify cmd 嗅探：从 workspace 探测第一个匹配的项目模板。
 *
 * 探测器优先级（找到第一个就用）：
 *   1. package.json 含有效 scripts.test → "npm test"
 *   2. pyproject.toml 或 pytest.ini      → "pytest"
 *   3. Cargo.toml                        → "cargo test"
 *   4. go.mod                            → "go test ./..."
 *
 * polyglot 仓库（如 Node + Python）按上面顺序选第一个；用户仍可
 * 通过 `-- verify "<cmd>"` 显式覆盖。npm placeholder 跳过避免必败。
 *
 * 注：reply 里的 "(auto-detected from package.json)" 字面量沿用 npm 措辞，
 * cargo/pytest/go 命中时也会显示该串——口径绑定测试，留待后续统一调整。
 */
type VerifyDetector = (workspace: string) => string | null;

const detectNpmTest: VerifyDetector = (workspace) => {
  try {
    const pkgPath = path.join(workspace, "package.json");
    if (!existsSync(pkgPath)) return null;
    const text = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(text) as { scripts?: { test?: unknown } };
    const test = pkg?.scripts?.test;
    if (typeof test !== "string" || !test.trim()) return null;
    if (/no test specified/i.test(test)) return null;
    return "npm test";
  } catch {
    return null;
  }
};

const detectPytest: VerifyDetector = (workspace) => {
  if (
    existsSync(path.join(workspace, "pyproject.toml")) ||
    existsSync(path.join(workspace, "pytest.ini"))
  ) {
    return "pytest";
  }
  return null;
};

const detectCargoTest: VerifyDetector = (workspace) =>
  existsSync(path.join(workspace, "Cargo.toml")) ? "cargo test" : null;

const detectGoTest: VerifyDetector = (workspace) =>
  existsSync(path.join(workspace, "go.mod")) ? "go test ./..." : null;

const VERIFY_DETECTORS: VerifyDetector[] = [
  detectNpmTest,
  detectPytest,
  detectCargoTest,
  detectGoTest,
];

export function detectVerifyCmd(workspace: string): string | null {
  for (const detector of VERIFY_DETECTORS) {
    const cmd = detector(workspace);
    if (cmd) return cmd;
  }
  return null;
}

/**
 * 判断 fix 产生的 diff 是否超过 scope 阈值。
 * 空 diff（找不到 summary 行）视为 ok（不 abort，但调用方会显式标 "no changes"）。
 */
export function evaluateDiffScope(
  stat: string,
  opts?: { maxFiles?: number; maxLines?: number }
): { exceeded: boolean; files: number; lines: number; reason?: string } {
  const maxFiles = opts?.maxFiles ?? DIFF_SCOPE_MAX_FILES;
  const maxLines = opts?.maxLines ?? DIFF_SCOPE_MAX_LINES;
  const summary = parseDiffStatSummary(stat);
  if (!summary) return { exceeded: false, files: 0, lines: 0 };
  const lines = summary.insertions + summary.deletions;
  const reasons: string[] = [];
  if (summary.files > maxFiles) reasons.push(`${summary.files} files > max-files=${maxFiles}`);
  if (lines > maxLines) reasons.push(`${lines} lines > max-lines=${maxLines}`);
  return {
    exceeded: reasons.length > 0,
    files: summary.files,
    lines,
    reason: reasons.length > 0 ? reasons.join("; ") : undefined,
  };
}

function buildBuiltinReply(prompt: string): string | null {
  if (prompt === "doctor") {
    return "Run `npm run dev -- doctor` or `node dist/cli.js doctor` for environment diagnostics.";
  }

  if (prompt === "setup") {
    return "Run `npm run dev -- setup` to open the interactive first-run setup.";
  }

  if (prompt === "config" || prompt === "/config") {
    return "Run `npm run dev -- config` to edit providers through the interactive config UI.";
  }

  if (prompt === "/exit") {
    return "Use Ctrl+C or close the current client to exit this session.";
  }

  return null;
}

const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "plan",
  "auto",
  "acceptEdits",
  "bypassPermissions",
  "dontAsk"
];

const DEFAULT_COMPACT_KEEP_RECENT_MESSAGES = 6;
const MAX_COMPACT_LIST_ITEMS = 5;
const DEFAULT_AUTO_COMPACT_THRESHOLD = 167_000;

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function clipLine(value: string, maxLength = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function extractFilePaths(text: string): string[] {
  const matches = text.match(/(?:\.{1,2}\/|\/)?[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+/g) ?? [];
  return matches.map((match) => match.replace(/[),.:;]+$/, ""));
}

function estimateMessageTokens(messages: EngineMessage[]): number {
  const totalChars = messages.reduce((sum, message) => sum + message.text.length, 0);
  return Math.ceil(totalChars / 4);
}

function matchesCommand(prompt: string, command: string): boolean {
  return prompt === command || prompt.startsWith(`${command} `);
}

function parseApprovalCommand(prompt: string, command: "/approve" | "/deny"): string | null | undefined {
  if (!matchesCommand(prompt, command)) {
    return undefined;
  }

  const suffix = prompt.slice(command.length).trim();
  return suffix || null;
}

function summarizeCheck(check: CompletionCheck): string {
  switch (check.type) {
    case "path-exists":
      return `${check.type}(${check.path})`;
    case "tool-available":
      return `${check.type}(${check.toolName})`;
    case "package-script-present":
      return `${check.type}(${check.scriptName})`;
    case "permission-mode":
      return `${check.type}(${check.allowedModes.join(",")})`;
    default:
      return check.type;
  }
}

function formatGoal(goal: GoalDefinition, index: number): string {
  return [
    `${index + 1}. ${goal.description}`,
    `priority: ${goal.priority}  risk: ${goal.riskLevel}  checks: ${goal.completionChecks.map(summarizeCheck).join(" | ")}`,
    `actions: ${goal.actions.length > 0 ? goal.actions.map((action) => action.type).join(" | ") : "none"}`
  ].join("\n");
}

function formatObservation(observation: CheckObservation): string {
  return `${observation.passed ? "pass" : "fail"} ${observation.checkId}: ${observation.detail}`;
}

function buildWriteLaneAssessment(plan: OrchestrationPlan, permissionMode: PermissionMode): string {
  if (plan.intent.type !== "create" && plan.intent.type !== "fix" && plan.intent.type !== "task") {
    return "write-lane: not needed for this orchestration round";
  }

  if (permissionMode === "default") {
    return "write-lane: blocked in executor for now; future write actions must route through approval-first orchestration because current mode is default";
  }

  if (permissionMode === "plan") {
    return "write-lane: evaluation complete; future write actions should enter approval-first orchestration instead of direct execution in plan mode";
  }

  return `write-lane: executor still read-only by design; future write actions may be enabled behind explicit approval and mode-aware safeguards (current mode: ${permissionMode})`;
}

function formatSkill(skill: SkillDefinition): string {
  return `${skill.name} (${skill.source}) - ${skill.description} [tools: ${skill.allowedTools.join(", ")}]`;
}

function formatWechatLoginState(state: WechatLoginStateView): string {
  const terminalQr =
    state.phase !== "error"
      ? renderTerminalQr(state.qrcodeImageContent ?? state.qrcode ?? null)
      : null;

  return [
    "WeChat",
    `phase: ${state.phase}`,
    `token-file: ${state.tokenFile}`,
    `base-url: ${state.baseUrl}`,
    `message: ${state.message}`,
    ...(state.qrcode ? [`qrcode: ${state.qrcode}`] : []),
    ...(state.qrcodeImageContent ? [`qrcode-image: ${state.qrcodeImageContent}`] : []),
    ...(state.ilinkBotId ? [`ilink-bot-id: ${state.ilinkBotId}`] : []),
    ...(state.ilinkUserId ? [`ilink-user-id: ${state.ilinkUserId}`] : []),
    ...(terminalQr ? ["", "terminal-qr:", terminalQr] : [])
  ].join("\n");
}

function renderTerminalQr(content: string | null): string | null {
  if (!content) {
    return null;
  }

  const qr = QRCode.create(content, {
    errorCorrectionLevel: "M"
  });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const quietZone = 2;
  const rows: string[] = [];

  for (let y = -quietZone; y < size + quietZone; y += 2) {
    let line = "";
    for (let x = -quietZone; x < size + quietZone; x += 1) {
      const upper = isQrDark(data, size, x, y);
      const lower = isQrDark(data, size, x, y + 1);

      if (upper && lower) {
        line += " ";
      } else if (upper) {
        line += "▀";
      } else if (lower) {
        line += "▄";
      } else {
        line += "█";
      }
    }
    rows.push(line);
  }

  return rows.join("\n");
}

function isQrDark(data: Uint8Array | number[], size: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= size || y >= size) {
    return false;
  }

  return Boolean(data[y * size + x]);
}

function injectSkillPrompt(skill: SkillDefinition, prompt: string): string {
  return [
    `[Skill: ${skill.name}]`,
    skill.prompt,
    `Allowed tools: ${skill.allowedTools.join(", ")}.`,
    "",
    prompt
  ].join("\n");
}

function buildTranscriptMarkdown(messages: EngineMessage[]): string {
  return messages
    .map((message) => `## ${message.role.toUpperCase()}\n\n${message.text}`)
    .join("\n\n");
}

function extractImageAttachments(channelSpecific?: Record<string, unknown>): EngineImageAttachment[] {
  const image = channelSpecific?.image as Record<string, unknown> | null | undefined;
  if (!image || typeof image.localPath !== "string" || !image.localPath.trim()) {
    return [];
  }

  return [
    {
      kind: "image",
      localPath: image.localPath,
      mimeType: typeof image.mimeType === "string" ? image.mimeType : undefined,
      fileName: typeof image.fileName === "string" ? image.fileName : undefined,
      width: typeof image.width === "number" ? image.width : undefined,
      height: typeof image.height === "number" ? image.height : undefined,
      sizeBytes: typeof image.sizeBytes === "number" ? image.sizeBytes : undefined,
      sourceUrl: typeof image.sourceUrl === "string" ? image.sourceUrl : undefined
    }
  ];
}

function getAudioTranscriptionState(channelSpecific?: Record<string, unknown>): {
  status: "completed" | "unavailable" | "failed";
  text?: string;
  reason?: string;
} | null {
  const audio = channelSpecific?.audio as Record<string, unknown> | null | undefined;
  if (!audio || typeof audio.transcriptionStatus !== "string") {
    return null;
  }

  if (
    audio.transcriptionStatus !== "completed" &&
    audio.transcriptionStatus !== "unavailable" &&
    audio.transcriptionStatus !== "failed"
  ) {
    return null;
  }

  return {
    status: audio.transcriptionStatus,
    text: typeof audio.transcriptionText === "string" ? audio.transcriptionText : undefined,
    reason: typeof audio.transcriptionReason === "string" ? audio.transcriptionReason : undefined
  };
}

function actionToRequiredTool(action: ExecutionAction): LocalToolName {
  switch (action.type) {
    case "inspect-file":
      return "read";
    case "inspect-symbol":
      return "definition";
    case "inspect-references":
      return "references";
    case "inspect-pattern":
      return "glob";
    case "run-package-script":
      return "bash";
    case "request-write-approval":
      return action.operation;
  }

  throw new Error(`Unsupported orchestration action: ${(action as ExecutionAction).type}`);
}

function resolveWorkspaceTarget(workspace: string, target: string): string {
  const absolutePath = path.isAbsolute(target) ? path.resolve(target) : path.resolve(workspace, target);
  const normalizedWorkspace = path.resolve(workspace);

  if (absolutePath !== normalizedWorkspace && !absolutePath.startsWith(`${normalizedWorkspace}${path.sep}`)) {
    throw new Error(`path is outside workspace: ${absolutePath}`);
  }

  return absolutePath;
}

type PendingApproval = {
  id: string;
  prompt: string;
  toolName: LocalToolName;
  detail: string;
  reason: string;
  createdAt: string;
  sessionId?: string;
};

type PendingOrchestrationApproval = OrchestrationApprovalRequest & {
  planGoal: string;
};

class LocalQueryEngine implements QueryEngine {
  private readonly sessionId = createId("session");
  private readonly messages: EngineMessage[];
  // #71：默认从磁盘加载 user skills（~/.codeclaw/skills/）；目录不存在时仅 builtin
  private readonly skillRegistry = createSkillRegistryFromDisk();
  private readonly listeners = new Set<() => void>();
  private interrupted = false;
  private abortController: AbortController | null = null;
  private modelLabel: string;
  private currentProvider: ProviderStatus | null;
  private fallbackProvider: ProviderStatus | null;
  private permissionMode: PermissionMode;
  private readonly permissions: PermissionManager;
  private pendingApprovals: PendingApproval[] = [];
  private compactCount = 0;
  private autoCompactCount = 0;
  private reactiveCompactCount = 0;
  private lastCompactedMessageCount = 0;
  private lastCompactSummary: string | null = null;
  private lastEstimatedTokens = 0;
  private readonly recentReadFiles = new Set<string>();
  private readonly changedFiles = new Set<string>();
  private readonly recentGapSignatures: string[] = [];
  private pendingOrchestrationApprovals: PendingOrchestrationApproval[] = [];
  private activeSkill: SkillDefinition | null = null;
  // #86：成本预算配置（构造时从 options.budget ?? env 决定）
  private readonly budgetConfig: BudgetConfig;
  private readonly slashRegistry = new SlashRegistry();
  // M1-B/B.2：native tool_use 注册表；env CODECLAW_NATIVE_TOOLS=true 时构造时注册 9 个 builtin
  private readonly toolRegistry: ToolRegistry = createToolRegistry();
  private readonly fsm = new EngineFsm();
  private readonly auditLog: AuditLog | null;
  // L2 Session Memory：dataDb 句柄；channel/userId 都齐备时才启用 recall + 持久化
  private readonly dataDb: Database.Database | null;

  /**
   * /ask 一次性 plan-mode 状态：
   *   - askModePending：保存被 /ask 临时切走前的 mode；非 null 表示"已 armed"
   *   - askModeShouldRestoreAtEnd：本轮结束时是否应执行 restore（在 submitMessage
   *     起点根据 prompt 是否仍为 /ask 决定）
   * 设计上"装弹一次只生效一轮"：/ask 起本轮不还，下一轮非 /ask 跑完再还。
   */
  private askModePending: { restore: PermissionMode } | null = null;
  private askModeShouldRestoreAtEnd = false;

  // W3-05：真实 provider token 用量（自 session 起累加；reset 不在 compact 时触发）
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private lastProviderModelId: string | null = null;

  /** 给 SlashCommand handler 通过 ctx.queryEngine 拿到 registry（供 /help 用） */
  public getSlashRegistry(): SlashRegistry {
    return this.slashRegistry;
  }

  /** 给测试 / 调试用：拿当前引擎的 AuditLog（可能为 null） */
  public getAuditLog(): AuditLog | null {
    return this.auditLog;
  }

  /**
   * 写一条审计事件（W3-01）。auditLog 为 null 或写入失败时 noop（不阻塞主流程）。
   * traceId 默认走 sessionId（每个 user prompt = 一个 trace 的简化模型）。
   */
  private audit(input: {
    actor: string;
    action: string;
    decision: AuditDecision;
    resource?: string | null;
    reason?: string | null;
    details?: Record<string, unknown> | null;
    traceId?: string;
  }): void {
    if (!this.auditLog) return;
    try {
      this.auditLog.append({
        traceId: input.traceId ?? this.sessionId,
        sessionId: this.sessionId,
        actor: input.actor,
        action: input.action,
        resource: input.resource ?? null,
        decision: input.decision,
        mode: this.permissionMode,
        reason: input.reason ?? null,
        details: input.details ?? null,
      });
    } catch {
      // 审计写失败不阻塞主流程；W3+ 可加 logger 警告
    }
  }

  /** 给 /cost / /status 等消费者读 FSM 当前快照 */
  public getFsmSnapshot(): FsmSnapshot {
    return this.fsm.snapshot();
  }

  /**
   * 同步 FSM phase 并返回对应 EngineEvent。
   * 让 submitMessage 等 yield phase 的地方既保持事件流不变、又顺手更新 FSM。
   */
  private phaseEvent(
    phase: "planning" | "executing" | "compacting" | "completed" | "halted"
  ): { type: "phase"; phase: typeof phase } {
    switch (phase) {
      case "planning":
        this.fsm.beginTurn();
        break;
      case "executing":
        this.fsm.enterExecuting();
        break;
      case "compacting":
        this.fsm.enterCompacting();
        break;
      case "completed":
        if (!this.fsm.isHalted()) {
          // 仍有待审批 → 这一轮其实是"被审批挡住"，halt reason 用 approval-required。
          const blockedByApproval =
            this.pendingApprovals.length + this.pendingOrchestrationApprovals.length > 0;
          if (blockedByApproval) {
            this.fsm.halt("approval-required", "blocked", {
              message: "user approval needed before continuing",
            });
          } else {
            this.fsm.halt("completed", "success");
          }
        }
        // /ask 装弹的一次性 plan mode：本轮结束 restore（仅在下一轮非 /ask 的 turn）
        if (this.askModeShouldRestoreAtEnd && this.askModePending) {
          this.permissionMode = this.askModePending.restore;
          this.permissions.setMode(this.permissionMode);
          this.askModePending = null;
          this.askModeShouldRestoreAtEnd = false;
        }
        break;
      case "halted":
        if (!this.fsm.isHalted()) {
          this.fsm.halt("user-cancelled", "abandoned");
        }
        break;
    }
    return { type: "phase", phase };
  }

  constructor(private readonly options: QueryEngineOptions) {
    this.currentProvider = options.currentProvider;
    this.fallbackProvider = options.fallbackProvider;
    this.permissionMode = options.permissionMode;
    this.modelLabel = this.currentProvider?.model ?? "scaffold";
    this.permissions = new PermissionManager(this.permissionMode);
    // #86：budget 优先 options.budget，其次 env CODECLAW_BUDGET_*
    this.budgetConfig = options.budget ?? readBudgetFromEnv();
    // W3-03：load 不按 sessionId 过滤（cross-session recovery 是预期使用场景，
    // 用户重启 / 切换 session 时仍能拿到上次的 pending）。隔离仅在 save/clear 上做：
    // session A 的 save 不会删 B 的 pending。这是对"覆盖"风险与"recovery 可见性"的折中。
    this.pendingApprovals = loadPendingApprovals(options.approvalsDir);
    loadBuiltins(this.slashRegistry);
    // M1-B/B.2：native tool_use opt-in 通过 env 启用；不设默认开启避免影响现有 baseline
    if (process.env.CODECLAW_NATIVE_TOOLS === "true") {
      registerBuiltinTools(this.toolRegistry);
      // M2-02：跨会话 memory tools；env CODECLAW_PROJECT_MEMORY=false 显式关
      if (process.env.CODECLAW_PROJECT_MEMORY !== "false") {
        registerMemoryTools(this.toolRegistry);
      }
      // M2-03：ExitPlanMode tool（plan mode 必备）；env CODECLAW_PLAN_MODE_STRICT=false 显式关
      if (process.env.CODECLAW_PLAN_MODE_STRICT !== "false") {
        registerPlanModeTool(this.toolRegistry);
      }
    }
    // #81：把 user skill manifest 的 commands[] 桥接到 slashRegistry
    // handler 行为 = 自动激活该 skill（等价 /skills use <name>）；冲突 builtin 时 skip
    for (const skill of this.skillRegistry.list()) {
      if (skill.source === "builtin" || !skill.commands?.length) continue;
      for (const cmd of skill.commands) {
        this.slashRegistry.register(
          {
            name: cmd.name,
            category: "plugin",
            risk: "low",
            summary: cmd.summary ?? `Activate skill: ${skill.name}`,
            handler: () => {
              // 复用 buildSkillsReply 的 'use <name>' 路径
              return { kind: "reply", text: this.buildSkillsReply(`/skills use ${skill.name}`) };
            },
          },
          "skip" // 与 builtin slash 冲突时跳过，不抛
        );
      }
    }
    // W3-01：开 audit.db 句柄。
    //   - 显式 auditDbPath === null → 禁用
    //   - vitest 环境下 + 未显式指定 → 禁用（避免测试污染 ~/.codeclaw/）
    //   - 其他情况：走默认 ~/.codeclaw/audit.db
    const isVitest = !!process.env.VITEST;
    const shouldDisable =
      options.auditDbPath === null || (options.auditDbPath === undefined && isVitest);
    if (shouldDisable) {
      this.auditLog = null;
    } else {
      try {
        const handle = openAuditDb({
          path: options.auditDbPath ?? undefined,
          singleton: false, // 多 engine 实例（测试 / multi-channel）需各自句柄
        });
        this.auditLog = new AuditLog(handle.db);
      } catch {
        // 打不开就降级：不阻塞引擎启动；后续写入 noop
        this.auditLog = null;
      }
    }
    // L2 Memory：与 audit 同套 vitest 保护规则。dataDbPath===null / vitest 默认禁用。
    const shouldDisableData =
      options.dataDbPath === null || (options.dataDbPath === undefined && isVitest);
    if (shouldDisableData) {
      this.dataDb = null;
    } else {
      try {
        const handle = openDataDb({
          path: options.dataDbPath ?? undefined,
          singleton: false,
        });
        this.dataDb = handle.db;
      } catch {
        this.dataDb = null;
      }
    }

    this.messages = [
      {
        id: createId("msg"),
        role: "assistant",
        text: options.currentProvider
          ? `CodeClaw is ready. Connected provider: ${options.currentProvider.displayName} (${this.modelLabel}).`
          : "CodeClaw is ready. No provider is configured yet.",
        source: "local"
      }
    ];

    // L2 召回：dataDb 可用 + channel/userId 齐备时，把最近 5 条摘要拼成 system message
    // 注入到 messages 头部（在 ready 消息之前），让 LLM 有跨 session 的上下文
    if (this.dataDb && options.channel && options.userId) {
      try {
        const recall = recallRecent(this.dataDb, options.channel, options.userId);
        if (recall.systemMessage) {
          this.messages.unshift({
            id: recall.systemMessage.id,
            role: recall.systemMessage.role,
            text: recall.systemMessage.text,
            source: recall.systemMessage.source,
          });
        }
      } catch {
        // 召回失败不阻塞启动
      }
    }

    if (this.pendingApprovals.length > 0) {
      const nextApproval = this.pendingApprovals[0];
      this.messages.push({
        id: createId("msg"),
        role: "assistant",
        text:
          this.pendingApprovals.length === 1
            ? `Recovered pending approval for ${nextApproval.toolName}. Run /approve or /deny.`
            : `Recovered ${this.pendingApprovals.length} pending approvals. Next: ${nextApproval.toolName} ${sanitizeForDisplay(nextApproval.detail)}. Run /approve or /deny.`,
        source: "local"
      });
    }

    this.lastEstimatedTokens = estimateMessageTokens(this.messages);
  }

  async *submitMessage(prompt: string, options?: QuerySubmitOptions): AsyncGenerator<EngineEvent> {
    // /ask v2 可能在 dispatch 后改写 trimmed（rewrite SlashResult），故用 let
    let trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }

    // /ask 装弹后的下一轮（且本轮不是 /ask 自己）→ 标记本轮末尾 restore
    if (this.askModePending && !trimmed.startsWith("/ask")) {
      this.askModeShouldRestoreAtEnd = true;
    }

    this.interrupted = false;
    const imageAttachments = extractImageAttachments(options?.channelSpecific);
    const audioTranscription = getAudioTranscriptionState(options?.channelSpecific);

    this.messages.push({
      id: createId("msg"),
      role: "user",
      text: trimmed,
      source: trimmed.startsWith("/") ? "command" : "user",
      attachments: imageAttachments
    });
    this.lastEstimatedTokens = estimateMessageTokens(this.messages);
    this.notifyListeners();

    yield this.phaseEvent("planning");

    if (!trimmed.startsWith("/")) {
      const autoCompactResult = this.maybeAutoCompact();
      if (autoCompactResult) {
        yield this.phaseEvent("compacting");
      }
    }

    yield this.phaseEvent("executing");

    // M1-B.2：multi-turn tool dispatch 期间需要为每个 assistant 回合换 id
    let messageId = createId("msg");
    let output = "";
    let assistantMessageSource: EngineMessageSource = "local";
    // M1-F：reasoning model 流分离用；LLM 路径填充，非 LLM 路径保持空，最终 push 兼容
    let contentBuf = "";
    let reasoningBuf = "";
    const approveTargetId = parseApprovalCommand(trimmed, "/approve");
    let denyTargetId = parseApprovalCommand(trimmed, "/deny");
    let approveTargetIdMutable = approveTargetId;
    void approveTargetIdMutable; // 占位避免 unused 警告（rewrite 路径不影响 approve/deny）
    // P0 W2 · ADR-003：新注册表前置于旧 resolveBuiltinReply。
    //   - 命中 reply → 走 builtinReply 分支（老下游无感知）
    //   - 命中 rewrite → 用 newPrompt 替换 trimmed 同 turn 走 LLM 路径（W2-12 /ask v2）
    //   - 命中 noop/passthrough 或未命中 → 继续走旧路径
    const slashDispatch = await this.slashRegistry.dispatch(trimmed, this);
    let slashReply: string | null = null;
    if (slashDispatch?.result.kind === "reply") {
      slashReply = slashDispatch.result.text;
    } else if (slashDispatch?.result.kind === "rewrite") {
      // /ask v2: 把 inline question 当作真正 prompt 走非 slash 路径
      trimmed = slashDispatch.result.newPrompt.trim();
      // 修正本轮 user message：text → newPrompt，source command → user
      const lastUserMsg = [...this.messages].reverse().find((m) => m.role === "user");
      if (lastUserMsg) {
        lastUserMsg.text = trimmed;
        lastUserMsg.source = "user";
      }
      // 重算 approve/deny target（newPrompt 里若含 /approve /deny 也应识别；通常不会）
      denyTargetId = parseApprovalCommand(trimmed, "/deny");
      // 同 turn 内本就装弹了 ask mode，question 跑完应当 restore
      if (this.askModePending) {
        this.askModeShouldRestoreAtEnd = true;
      }
      this.lastEstimatedTokens = estimateMessageTokens(this.messages);
    }
    const builtinReply = slashReply !== null ? slashReply : this.resolveBuiltinReply(trimmed);
    const commandReply = builtinReply === null ? await this.resolveCommandReply(trimmed) : undefined;
    const localToolName = builtinReply === null ? detectLocalTool(trimmed) : null;

    yield {
      type: "message-start",
      messageId,
      role: "assistant"
    };

    if (builtinReply !== null) {
      output = builtinReply;
      yield {
        type: "message-delta",
        messageId,
        delta: output
      };
    } else if (commandReply !== undefined) {
      output = commandReply;
      yield {
        type: "message-delta",
        messageId,
        delta: output
      };
    } else if (approveTargetId !== undefined && this.pendingApprovals.length > 0) {
      const approval = this.takePendingApproval(approveTargetId);
      if (!approval) {
        output = approveTargetId
          ? `No pending approval with id ${approveTargetId}.`
          : "No pending approval.";
        yield {
          type: "message-delta",
          messageId,
          delta: output
        };
        yield {
          type: "message-complete",
          messageId,
          text: output
        };
        this.messages.push({
          id: messageId,
          role: "assistant",
          text: output,
          source: "local"
        });
        this.notifyListeners();
        yield this.phaseEvent("completed");
        return;
      }
      this.persistPendingApprovals();
      // W3-01：用户批准 pending approval → 审计
      this.audit({
        actor: "user",
        action: "approval.granted",
        decision: "approved",
        resource: approval.toolName,
        reason: approval.reason,
        details: { approvalId: approval.id, detail: approval.detail },
      });
      yield {
        type: "approval-cleared",
        approvalId: approval.id
      };
      if (!this.isToolAllowedByActiveSkill(approval.toolName)) {
        output = this.buildSkillToolBlockReply(approval.toolName);
        yield {
          type: "message-delta",
          messageId,
          delta: output
        };
        yield {
          type: "tool-end",
          toolName: approval.toolName,
          status: "blocked"
        };
        yield {
          type: "message-complete",
          messageId,
          text: output
        };
        this.messages.push({
          id: messageId,
          role: "assistant",
          text: output,
          source: "local"
        });
        this.notifyListeners();
        yield this.phaseEvent("completed");
        return;
      }
      yield {
        type: "tool-start",
        toolName: approval.toolName,
        detail: approval.prompt
      };
      const localToolResult = await runLocalTool(approval.prompt, this.options.workspace);
      if (!isHandledLocalToolResult(localToolResult)) {
        throw new Error(`Tool handler missing for ${approval.toolName}`);
      }
      output = localToolResult.output;
      this.recordToolActivity(approval.toolName, approval.detail, output);
      yield {
        type: "message-delta",
        messageId,
        delta: output
      };
      yield {
        type: "tool-end",
        toolName: localToolResult.toolName ?? approval.toolName,
        status: localToolResult.status ?? "completed"
      };
    } else if (approveTargetId !== undefined && this.pendingOrchestrationApprovals.length > 0) {
      const approval = this.takePendingOrchestrationApproval(approveTargetId);
      if (!approval) {
        output = approveTargetId
          ? `No pending orchestration approval with id ${approveTargetId}.`
          : "No pending orchestration approval.";
        yield {
          type: "message-delta",
          messageId,
          delta: output
        };
      } else {
        const executionPlan = await buildApprovedExecutionPlan(approval, this.options.workspace);
        if (!this.isToolAllowedByActiveSkill(executionPlan.toolName)) {
          output = this.buildSkillToolBlockReply(executionPlan.toolName);
          yield {
            type: "message-delta",
            messageId,
            delta: output
          };
          yield {
            type: "tool-end",
            toolName: executionPlan.toolName,
            status: "blocked"
          };
          yield {
            type: "message-complete",
            messageId,
            text: output
          };
          this.messages.push({
            id: messageId,
            role: "assistant",
            text: output,
            source: "local"
          });
          this.notifyListeners();
          yield this.phaseEvent("completed");
          return;
        }
        yield {
          type: "tool-start",
          toolName: executionPlan.toolName,
          detail: executionPlan.prompt
        };
        const localToolResult = await runLocalTool(executionPlan.prompt, this.options.workspace);
        if (!isHandledLocalToolResult(localToolResult)) {
          throw new Error(`Tool handler missing for approved orchestration ${executionPlan.toolName}`);
        }
        output = this.buildOrchestrationApprovalDecisionReply(approval, "approved", localToolResult.output);
        this.recordToolActivity(executionPlan.toolName, approval.target, localToolResult.output);
        yield {
          type: "message-delta",
          messageId,
          delta: output
        };
        yield {
          type: "tool-end",
          toolName: executionPlan.toolName,
          status: localToolResult.status ?? "completed"
        };
      }
    } else if (denyTargetId !== undefined && this.pendingApprovals.length > 0) {
      const approval = this.takePendingApproval(denyTargetId);
      if (!approval) {
        output = denyTargetId
          ? `No pending approval with id ${denyTargetId}.`
          : "No pending approval.";
        yield {
          type: "message-delta",
          messageId,
          delta: output
        };
        yield {
          type: "message-complete",
          messageId,
          text: output
        };
        this.messages.push({
          id: messageId,
          role: "assistant",
          text: output,
          source: "local"
        });
        this.notifyListeners();
        yield this.phaseEvent("completed");
        return;
      }
      this.persistPendingApprovals();
      // W3-01：用户拒绝 pending approval → 审计
      this.audit({
        actor: "user",
        action: "approval.denied",
        decision: "rejected",
        resource: approval.toolName,
        reason: approval.reason,
        details: { approvalId: approval.id, detail: approval.detail },
      });
      yield {
        type: "approval-cleared",
        approvalId: approval.id
      };
      output = `Denied pending ${approval.toolName}: ${approval.reason}`;
      yield {
        type: "message-delta",
        messageId,
        delta: output
      };
      yield {
        type: "tool-end",
        toolName: approval.toolName,
        status: "blocked"
      };
    } else if (denyTargetId !== undefined && this.pendingOrchestrationApprovals.length > 0) {
      const approval = this.takePendingOrchestrationApproval(denyTargetId);
      output = approval
        ? this.buildOrchestrationApprovalDecisionReply(approval, "denied")
        : denyTargetId
          ? `No pending orchestration approval with id ${denyTargetId}.`
          : "No pending orchestration approval.";
      yield {
        type: "message-delta",
        messageId,
        delta: output
      };
    } else if (localToolName) {
      if (!this.isToolAllowedByActiveSkill(localToolName)) {
        output = this.buildSkillToolBlockReply(localToolName);
        yield {
          type: "message-delta",
          messageId,
          delta: output
        };
        yield {
          type: "tool-end",
          toolName: localToolName,
          status: "blocked"
        };
      } else {
        const inspection = inspectLocalTool(trimmed, this.permissions);

        if (inspection.decision?.behavior === "allow") {
          // W3-01：工具自动放行也是审计点
          this.audit({
            actor: "user",
            action: `tool.${localToolName}`,
            decision: "allow",
            resource: inspection.detail ?? trimmed,
            reason: inspection.decision.reason ?? null,
          });
          yield {
            type: "tool-start",
            toolName: localToolName,
            detail: trimmed
          };
          const localToolResult = await runLocalTool(trimmed, this.options.workspace);
          if (!isHandledLocalToolResult(localToolResult)) {
            throw new Error(`Tool handler missing for ${localToolName}`);
          }
          output = localToolResult.output;
          this.recordToolActivity(localToolName, inspection.detail ?? "", output);
          yield {
            type: "message-delta",
            messageId,
            delta: output
          };
          yield {
            type: "tool-end",
            toolName: localToolResult.toolName ?? localToolName,
            status: localToolResult.status ?? "completed"
          };
        } else if (inspection.decision?.behavior === "ask" && inspection.toolName) {
          const pendingApproval: PendingApproval = {
            id: createId("approval"),
            prompt: trimmed,
            toolName: inspection.toolName,
            detail: inspection.detail ?? trimmed,
            reason: inspection.decision.reason,
            createdAt: new Date().toISOString(),
            sessionId: this.sessionId
          };
          this.pendingApprovals.push(pendingApproval);
          this.persistPendingApprovals();
          // W3-01：工具入 pending 队列也是审计点（可后续与 approval.granted/denied 关联）
          this.audit({
            actor: "agent",
            action: `tool.${inspection.toolName}`,
            decision: "pending",
            resource: inspection.detail ?? trimmed,
            reason: inspection.decision.reason ?? null,
            details: { approvalId: pendingApproval.id },
          });
          const activeApproval = this.pendingApprovals[0] ?? pendingApproval;
          output =
            this.pendingApprovals.length === 1
              ? `Approval required for ${inspection.toolName}: ${inspection.decision.reason}\nRun /approve or /deny.`
              : `Approval queued for ${inspection.toolName}: ${inspection.decision.reason}\nPending approvals: ${this.pendingApprovals.length}. Next up: ${activeApproval.toolName} ${sanitizeForDisplay(activeApproval.detail)}.\nRun /approve or /deny to process the queue.`;
          yield {
            type: "approval-request",
            approvalId: activeApproval.id,
            toolName: activeApproval.toolName,
            detail: activeApproval.detail,
            reason: activeApproval.reason,
            queuePosition: 1,
            totalPending: this.pendingApprovals.length
          };
          yield {
            type: "message-delta",
            messageId,
            delta: output
          };
        } else {
          // W3-01：工具被权限策略直接拒（deny / dontAsk 无缓存）→ 审计
          this.audit({
            actor: "agent",
            action: `tool.${localToolName}`,
            decision: "deny",
            resource: inspection.detail ?? trimmed,
            reason: inspection.decision?.reason ?? "permission denied",
          });
          output = `${localToolName[0].toUpperCase()}${localToolName.slice(1)} blocked: ${inspection.decision?.reason ?? "permission denied"}`;
          yield {
            type: "message-delta",
            messageId,
            delta: output
          };
          yield {
            type: "tool-end",
            toolName: localToolName,
            status: "blocked"
          };
        }
      }
    } else if (!this.options.currentProvider) {
      output = 'No available provider. Run `codeclaw setup` or `codeclaw config` to configure one.';
      yield {
        type: "message-delta",
        messageId,
        delta: output
      };
    } else if (audioTranscription && audioTranscription.status !== "completed") {
      output = this.buildUnavailableAudioTranscriptionReply(audioTranscription);
      assistantMessageSource = "local";
      yield {
        type: "message-delta",
        messageId,
        delta: output
      };
    } else if (imageAttachments.length > 0 && detectProviderCapabilities(this.currentProvider).vision === "unsupported") {
      output = this.buildUnsupportedImageInputReply();
      assistantMessageSource = "local";
      yield {
        type: "message-delta",
        messageId,
        delta: output
      };
    } else {
      // #86：调 LLM 前先 check budget；exceeded + block → 提前中止
      const budgetVerdict = this.evaluateBudgetGate();
      if (budgetVerdict?.shouldBlock) {
        output = `[budget exceeded] ${budgetVerdict.detail}\nTo continue, raise CODECLAW_BUDGET_* env or set onExceeded='warn'.`;
        assistantMessageSource = "local";
        yield {
          type: "message-delta",
          messageId,
          delta: output,
        };
        // 跳过 LLM 流程，直接走到 message-complete
        this.messages.push({
          id: messageId,
          role: "assistant",
          text: output,
          source: assistantMessageSource,
        });
        this.notifyListeners();
        yield { type: "message-complete", messageId, text: output };
        yield this.phaseEvent("completed");
        return;
      }
      if (budgetVerdict?.status === "warn") {
        const note = `[budget warning] ${budgetVerdict.detail}\n`;
        output += note;
        yield { type: "message-delta", messageId, delta: note };
      }

      assistantMessageSource = "model";
      const providers = [this.currentProvider, this.fallbackProvider].filter(
        (provider, index, list): provider is ProviderStatus =>
          provider !== null && list.findIndex((item) => item?.type === provider.type) === index
      );
      // M1-B.2 multi-turn：每个 turn 一次 LLM streaming + 可选 tool 派发；MAX_TURNS 防无限循环
      const MAX_TOOL_TURNS = 25;
      let toolTurns = 0;
      const hasNativeTools = this.toolRegistry.list().length > 0;
      let lastError: Error | null = null;
      let allowFallback = true;
      // M1-F：contentBuf / reasoningBuf 已在 submitMessage 顶部 hoist；这里只重置每 turn
      multiTurn: while (true) {
        let collectedToolCalls: ToolCallEvent[] = [];
        // 每个 turn 重置：assistant.text 只存当前 turn content，reasoning 走可选字段
        contentBuf = "";
        reasoningBuf = "";
        let reactiveCompactTriggered = false;
        lastError = null;
        allowFallback = true;
        // M2-03：每 turn 重新构造 toolSchemas，让 ExitPlanMode 切 mode 后下一 turn 拿全工具
        const toolSchemas = hasNativeTools ? this.buildStreamToolSchemas() : undefined;

        // M1-D：Token 预算检查（warn-only）+ M2-01：超阈值时真压缩旧 turn
        if (this.currentProvider) {
          const toolsSchemaTokens = toolSchemas ? estimateToolsSchemaTokens(toolSchemas) : 0;
          const budgetReport = checkTokenBudget(
            this.getProviderMessages(),
            this.currentProvider,
            toolsSchemaTokens
          );
          warnIfBudgetExceeded(budgetReport);
          this.lastEstimatedTokens = budgetReport.estimatedTokens;

          // M2-01：≥95% utilization 触发 autoCompact（旧 turn → 摘要 assistant message）；
          // channel/userId 缺失时跳过（不能 saveMemoryDigest）但 stream 继续，仅 warn
          if (budgetReport.shouldHardCut && this.options.channel && this.options.userId) {
            try {
              const compactResult = await autoCompactIfNeeded(
                this.messages,
                this.currentProvider,
                {
                  keepRecentTurns: 5,
                  hardCutFallback: true,
                  invoker: createProviderSummarizer(this.currentProvider),
                  sessionId: this.sessionId,
                  channel: this.options.channel,
                  userId: this.options.userId,
                  dataDb: this.dataDb,
                  abortSignal: this.abortController?.signal,
                }
              );
              if (compactResult.compacted) {
                // messages 是 readonly 引用——用 splice 原地替换内容保持引用稳定
                this.messages.splice(0, this.messages.length, ...compactResult.messages);
                this.autoCompactCount += 1;
                this.notifyListeners();
                this.audit({
                  actor: "agent",
                  action: "memory.auto-compact",
                  decision: "allow",
                  reason: `compacted ${compactResult.compactedTurnCount} messages`,
                });
                yield this.phaseEvent("compacting");
              }
            } catch (err) {
              process.stderr.write(
                `[auto-compact] failed: ${err instanceof Error ? err.message : String(err)}\n`
              );
            }
          }
        }

        while (true) {
          lastError = null;
          allowFallback = true;
          this.abortController = new AbortController();

          // #69：把 provider 重试 + fallback 编排交给 runWithProviderChain；
          // 这里只关心：每次新 attempt 重置 token 计数 + 成功 attempt 写 llm_calls_raw。
          let currentCall: {
            provider: ProviderStatus;
            startMs: number;
            inputTokens: number;
            outputTokens: number;
            modelId?: string;
          } | null = null;

          const chain = runWithProviderChain({
            providers,
            abortSignal: this.abortController.signal,
            invoke: (provider) => {
              currentCall = {
                provider,
                startMs: Date.now(),
                inputTokens: 0,
                outputTokens: 0,
                modelId: provider.model,
              };
              return streamProviderResponse(provider, this.getProviderMessages(), {
                fetchImpl: this.options.fetchImpl,
                abortSignal: this.abortController!.signal,
                onUsage: (usage) => {
                  // W3-05：累加真实 token 用量到 session
                  this.sessionInputTokens += usage.inputTokens ?? 0;
                  this.sessionOutputTokens += usage.outputTokens ?? 0;
                  this.lastProviderModelId = usage.modelId ?? this.lastProviderModelId;
                  if (currentCall) {
                    currentCall.inputTokens = usage.inputTokens ?? currentCall.inputTokens;
                    currentCall.outputTokens = usage.outputTokens ?? currentCall.outputTokens;
                    currentCall.modelId = usage.modelId ?? currentCall.modelId;
                  }
                },
                // M1-B.2：注入 tools schema + 收集 LLM 发起的 tool_call
                tools: toolSchemas,
                onToolCall: hasNativeTools
                  ? (call) => collectedToolCalls.push(call)
                  : undefined,
                // M1-F：分流收集 content / reasoning
                onContent: (chunk) => {
                  contentBuf += chunk;
                },
                onReasoning: (chunk) => {
                  reasoningBuf += chunk;
                },
              });
            },
            onAttempt: (attempt) => {
              // W3-17：成功 attempt → 写 llm_calls_raw（含 USD 估算）
              if (
                attempt.ok &&
                currentCall &&
                (currentCall.inputTokens > 0 || currentCall.outputTokens > 0)
              ) {
                recordCall(this.dataDb, {
                  traceId: this.sessionId,
                  sessionId: this.sessionId,
                  provider: currentCall.provider.type,
                  modelId: currentCall.modelId ?? currentCall.provider.model,
                  inputTokens: currentCall.inputTokens,
                  outputTokens: currentCall.outputTokens,
                  latencyMs: Date.now() - currentCall.startMs,
                });
              }
            },
          });

          let chainResult: RunChainResult | undefined;
          let producedAny = false;
          try {
            while (true) {
              const next = await chain.next();
              if (next.done) {
                chainResult = next.value;
                break;
              }
              producedAny = true;
              output += next.value;
              yield {
                type: "message-delta",
                messageId,
                delta: next.value,
              };
            }
          } catch (error) {
            // chain 仅会向上抛 AbortError；其余 provider 错都被 chain 收编进 chainResult
            if ((error as Error).name === "AbortError") {
              this.interrupted = true;
            } else {
              throw error;
            }
          } finally {
            this.abortController = null;
          }

          if (this.interrupted) {
            break;
          }

          if (chainResult?.ok) {
            lastError = null;
            break;
          }

          lastError = chainResult?.lastError ?? null;
          // 已 yield 过 chunk → outer 也不该再 retry（避免重叠）
          allowFallback = !producedAny;
          if (producedAny) break;

          if (
            !output &&
            lastError &&
            !reactiveCompactTriggered &&
            this.shouldReactiveCompact(lastError)
          ) {
            const reactiveCompactResult = this.performCompact(DEFAULT_COMPACT_KEEP_RECENT_MESSAGES);
            if (reactiveCompactResult) {
              reactiveCompactTriggered = true;
              this.reactiveCompactCount += 1;
              yield this.phaseEvent("compacting");
              continue;
            }
          }

          break;
        }

        if (!this.interrupted && lastError) {
          if (!output) {
            output = this.buildProviderFailureMessage(lastError);
            assistantMessageSource = "local";
            // M1-F：error path 写到 contentBuf 让最终 push 也用上
            contentBuf = output;
            yield {
              type: "message-delta",
              messageId,
              delta: output
            };
          } else if (!allowFallback) {
            const failureNote = `\n[stream interrupted: ${lastError.message}]`;
            output += failureNote;
            // M1-F：把中断提示也追加到 contentBuf；assistant.text 完整带上
            contentBuf += failureNote;
            yield {
              type: "message-delta",
              messageId,
              delta: failureNote
            };
          }
        } else if (!this.interrupted && !output && collectedToolCalls.length === 0) {
          output = "Provider returned an empty response.";
          assistantMessageSource = "local";
          contentBuf = output;
          yield {
            type: "message-delta",
            messageId,
            delta: output
          };
        }

        // M1-B.2：multi-turn 出口判定 — 没工具 / 已中断 / 已超 turn 上限 / 有错 → 跳出
        if (
          !hasNativeTools ||
          collectedToolCalls.length === 0 ||
          this.interrupted ||
          lastError ||
          toolTurns >= MAX_TOOL_TURNS
        ) {
          break multiTurn;
        }

        // M1-B.2：本回合 LLM 要求调工具 — push 当前 assistant 消息（含 toolCalls 字段）+
        // 串行 invoke 工具 + push role:"tool" 消息 + 重置 messageId/output 进入下一轮
        // M1-F：text 只存 content（最终答案），reasoning 单独字段，避免 provider replay 污染
        this.messages.push({
          id: messageId,
          role: "assistant",
          text: contentBuf,
          source: assistantMessageSource,
          toolCalls: collectedToolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
          ...(reasoningBuf ? { reasoning: reasoningBuf } : {}),
        });
        this.notifyListeners();
        yield { type: "message-complete", messageId, text: contentBuf };

        for (const call of collectedToolCalls) {
          const detailPreview = JSON.stringify(call.args ?? {}).slice(0, 100);

          // M2-04：在 invoke 前同步 evaluate；deny / ask 都 push role:"tool" 阻 LLM 重试
          // 真异步 pending + /approve 恢复留 M3-04 hooks 阶段做
          const permInput = buildPermissionInputFromToolCall(call);
          const decision = permInput ? this.permissions.evaluate(permInput) : null;
          if (decision && decision.behavior !== "allow") {
            yield { type: "tool-start", toolName: call.name, detail: detailPreview };
            const denialReason =
              decision.behavior === "deny"
                ? `User policy denied this tool call. Reason: ${decision.reason}. ` +
                  `Do not retry the same call; consider alternatives.`
                : `Approval required for ${call.name} (${decision.risk} risk). ` +
                  `Reason: ${decision.reason}. Run /mode bypassPermissions or /mode dontAsk to allow, or change approach.`;
            this.messages.push({
              id: createId("tool"),
              role: "tool",
              text: denialReason,
              source: "local",
              toolCallId: call.id,
              toolName: call.name,
            });
            this.notifyListeners();
            this.audit({
              actor: "agent",
              action: `tool.${call.name}`,
              decision: decision.behavior === "deny" ? "deny" : "pending",
              resource: detailPreview,
              reason: decision.reason,
            });
            yield { type: "tool-end", toolName: call.name, status: "blocked" };
            continue; // 不调 invoke
          }

          // allow / skip-evaluate（memory_*/ExitPlanMode）→ 正常 invoke
          yield { type: "tool-start", toolName: call.name, detail: detailPreview };
          const invokeResult = await this.toolRegistry.invoke(call.name, call.args, {
            workspace: this.options.workspace,
            permissionManager: this.permissions,
          });
          this.messages.push({
            id: createId("tool"),
            role: "tool",
            text: invokeResult.content,
            source: "local",
            toolCallId: call.id,
            toolName: call.name,
          });
          this.notifyListeners();
          yield {
            type: "tool-end",
            toolName: call.name,
            status: invokeResult.ok ? "completed" : "failed",
          };

          // M2-03：ExitPlanMode sentinel → 切 default mode（plan→execute 阶段切换）
          if (
            call.name === "ExitPlanMode" &&
            invokeResult.ok &&
            invokeResult.content.startsWith(EXIT_PLAN_SENTINEL)
          ) {
            const planMd = invokeResult.content.slice(EXIT_PLAN_SENTINEL.length).trim();
            this.permissionMode = "default";
            this.permissions.setMode("default");
            this.audit({
              actor: "agent",
              action: "plan.exit",
              decision: "allow",
              reason: `plan submitted (${planMd.length} chars)`,
              details: { plan: planMd.slice(0, 500) },
            });
          }
        }

        // 准备下一轮 assistant 流：新 messageId、清空 output；message-start 事件让上层 UI 拉新条
        output = "";
        assistantMessageSource = "model";
        messageId = createId("msg");
        yield { type: "message-start", messageId, role: "assistant" };
        toolTurns += 1;
      }
    }

    if (this.interrupted) {
      const haltedText = output ? `${output.trimEnd()} [interrupted]` : "[interrupted]";
      this.messages.push({
        id: messageId,
        role: "assistant",
        text: haltedText,
        source: assistantMessageSource
      });
      this.notifyListeners();
      yield {
        type: "message-complete",
        messageId,
        text: haltedText
      };
      yield this.phaseEvent("halted");
      return;
    }

    // M1-F：LLM 路径用 contentBuf（干净答案）；非 LLM 路径（slash / 本地工具）contentBuf 为空，
    // 退化到 output（含命令回复 / 工具输出）。两路兼容。
    const isLlmPath = assistantMessageSource === "model";
    const finalText = isLlmPath ? (contentBuf || output) : output;
    const finalReasoning = isLlmPath && reasoningBuf ? reasoningBuf : undefined;
    this.messages.push({
      id: messageId,
      role: "assistant",
      text: finalText,
      source: assistantMessageSource,
      ...(finalReasoning ? { reasoning: finalReasoning } : {}),
    });
    this.notifyListeners();
    yield {
      type: "message-complete",
      messageId,
      text: finalText
    };
    yield this.phaseEvent("completed");
  }

  private resolveBuiltinReply(prompt: string): string | null {
    // 裸字面量 "help" 走 registry，与 "/help" 等价输出
    if (prompt === "help") {
      return this.slashRegistry.generateHelp();
    }

    if (parseApprovalCommand(prompt, "/approve") !== undefined) {
      return this.pendingApprovals.length > 0 || this.pendingOrchestrationApprovals.length > 0
        ? null
        : "No pending approval.";
    }

    if (parseApprovalCommand(prompt, "/deny") !== undefined) {
      return this.pendingApprovals.length > 0 || this.pendingOrchestrationApprovals.length > 0
        ? null
        : "No pending approval.";
    }

    // 已迁移到 SlashRegistry（W2-02/03）：
    //   /status /resume /session /providers /approvals
    //   /context /memory /diff /skills /hooks /init
    //   /compact /model /mode /doctor
    // 老的 handle*/build* 私有方法保留供 registry 通过 duck-type 调用。

    return buildBuiltinReply(prompt);
  }

  private async resolveCommandReply(prompt: string): Promise<string | undefined> {
    // 已迁移到 SlashRegistry（W2-02 batch 4）：
    //   /doctor /summary /export /reload-plugins /debug-tool-call /mcp /wechat
    // 老的 build*/handle* 私有方法保留供 registry 通过 duck-type 调用。

    // /review /orchestrate 已迁移到 SlashRegistry（W2-02 batch7），
    // 实际逻辑在 runReviewCommand / runOrchestrateCommand。

    return undefined;
  }

  /**
   * 共用：跑出一个 plan 的完整 execute → reflect → gap → pendingApproval 副作用流。
   * 由 /review / /orchestrate / /fix 调用。
   *
   * 多轮循环（task #59）：
   *   - 当 reflector decision = "replan"、无 pending approval、且 round < maxRounds 时，
   *     用最新 gap 上下文 rebuild plan 再跑一轮
   *   - reflector decision != "replan" → break（complete / escalated / approval-required）
   *   - pendingOrchestrationApprovals 非空 → break（被审批挡住）
   *   - round 达到 maxRounds 仍想 replan → halt(max-turns, partial) 并 break
   *
   * /review 传 maxRounds=1（read-only 永远单轮）。
   */
  private async executePlanWithSideEffects(
    initialPlan: OrchestrationPlan,
    options: { maxRounds?: number } = {}
  ): Promise<{
    execution: Awaited<ReturnType<typeof executeOrchestrationPlan>>;
    reflector: ReturnType<typeof reflectOnExecution>;
    rounds: number;
  }> {
    const maxRounds = Math.max(1, options.maxRounds ?? 3);
    let plan = initialPlan;
    let execution!: Awaited<ReturnType<typeof executeOrchestrationPlan>>;
    let reflector!: ReturnType<typeof reflectOnExecution>;
    let round = 0;

    while (true) {
      round += 1;

      execution = await executeOrchestrationPlan(plan, this.buildOrchestrationContext());
      this.fsm.enterReflecting();
      reflector = reflectOnExecution(plan.goals, execution, this.recentGapSignatures);

      const gapSignature = buildGapSignature(execution.gaps);
      if (gapSignature) {
        this.recentGapSignatures.push(gapSignature);
        if (this.recentGapSignatures.length > 5) {
          this.recentGapSignatures.shift();
        }
      }

      this.pendingOrchestrationApprovals = execution.approvalRequests
        .filter((request) => request.status === "pending")
        .map((request) => ({
          ...request,
          planGoal: plan.userGoal,
        }));

      if (reflector.decision !== "replan") break;
      if (this.pendingOrchestrationApprovals.length > 0) break;
      if (round >= maxRounds) {
        this.fsm.halt("max-turns", "partial", {
          message: `replan loop hit max rounds (${maxRounds})`,
        });
        break;
      }

      // 进下一轮：FSM 转 planning（不 bump turn），用更新后的 ctx 重 build plan
      this.fsm.enterPlanning();
      plan = buildOrchestrationPlan(plan.userGoal, this.buildOrchestrationContext());
    }

    // 修 review H1：显式按 reflector decision 落 halt，避免外层 phaseEvent("completed")
    // 把 escalated / approval-required 误标成 completed/success
    this.finalizeOrchestrationHalt(reflector);

    return { execution, reflector, rounds: round };
  }

  /**
   * 把 reflector decision 翻译成 FSM halt 状态，确保 /cost / /status / 审计读到的
   * lastHalt 能精确反映"这一轮工作以什么方式结束"。
   *   - escalated → halt(completed, partial)：自然结束，但目标未达成，用户应当干预
   *   - approval-required → halt(approval-required, blocked)：等审批
   *   - complete / replan：不在此 halt，留给外层 phaseEvent("completed") 或多轮已 halt 的 max-turns
   *
   * 注意：调用前若 fsm 已 halted（max-turns 路径），此函数为 no-op（FSM 内部 isHalted 守卫）。
   */
  private finalizeOrchestrationHalt(reflector: ReflectorResult): void {
    if (this.fsm.isHalted()) return;
    switch (reflector.decision) {
      case "escalated":
        this.fsm.halt("completed", "partial", {
          message: "reflector escalated: repeated gap",
        });
        break;
      case "approval-required":
        this.fsm.halt("approval-required", "blocked", {
          message: "reflector requested user approval",
        });
        break;
      // "complete" / "replan" → 留给外层 phaseEvent 处理或已被 max-turns halt
    }
  }

  /** 给 /review slash builtin 用 */
  /**
   * 给 /fix slash builtin 用：fix-intent 编排 + 可选 verify 闭环。
   *
   * 输入形态：
   *   /fix <goal>                          plan/execute/reflect 后返回
   *   /fix <goal> -- verify "<cmd>"        跑前/跑后跑 cmd 自动判定 broken→fixed
   *
   * verify 行为：
   *   - 跑前：执行 cmd（exit 0 = 已修，abort）
   *   - 跑后：再执行 cmd（exit 0 = 修好，否则附 stderr）
   *   - 末尾附 git diff --stat 信息
   *
   * diff_scope 校验：
   *   - 跑后用 evaluateDiffScope 校验 git diff 范围
   *   - 超过 max_files / max_lines 时 reply 末尾标 "diff-scope: ABORT"
   *   - 不自动 rollback；让用户决策是否保留
   *
   * verify 自动嗅探：
   *   - 未显式给 -- verify 时，从 workspace 嗅探多语言项目模板：
   *     package.json → npm test / pyproject.toml | pytest.ini → pytest /
   *     Cargo.toml → cargo test / go.mod → go test ./...
   *   - 优先级固定（npm > pytest > cargo > go），polyglot 仓库取最高优先
   *   - 找到则自动用，reply 里标注 (auto-detected)；找不到则不跑 verify
   */
  public async runFixCommand(prompt: string): Promise<string> {
    const stripped = prompt.replace("/fix", "").trim();
    if (!stripped) {
      return "Usage: /fix <bug description> [-- verify \"<test cmd>\"]";
    }

    // 解析 -- verify "<cmd>"（v2）
    const { goal: fixGoal, verifyCmd: explicitVerify } = parseFixArgs(stripped);
    if (!fixGoal) {
      return "Usage: /fix <bug description> [-- verify \"<test cmd>\"]";
    }

    const fixSkill = this.skillRegistry.get("fix");
    const plan = buildOrchestrationPlan(`fix ${fixGoal}`, this.buildOrchestrationContext());
    const disallowedSkillTools = this.getDisallowedSkillToolsForPlan(plan, fixSkill);

    if (disallowedSkillTools.length > 0) {
      return [
        "Fix",
        `goal: ${fixGoal}`,
        `skill: ${fixSkill?.name ?? "fix"}`,
        `blocked-tools: ${disallowedSkillTools.join(", ")}`,
        `reason: fix lane only allows ${fixSkill?.allowedTools.join(", ") ?? "default tools"}`
      ].join("\n");
    }

    const cwd = this.options.workspace;

    // 未显式给 -- verify 时，从 workspace 嗅探。vitest 环境下禁用避免自递归
    // ——CodeClaw 根目录 scripts.test=vitest，在测试里再跑会重新触发整个套件。
    const isVitest = !!process.env.VITEST;
    const detectedVerify = !explicitVerify && !isVitest ? detectVerifyCmd(cwd) : null;
    const verifyCmd: string | undefined = explicitVerify ?? detectedVerify ?? undefined;
    const autoDetected = !!detectedVerify && !explicitVerify;
    const verifyCmdLabel = verifyCmd
      ? `verify-cmd: ${verifyCmd}${autoDetected ? " (auto-detected from package.json)" : ""}`
      : "";

    // v2 跑前 verify_broken
    let preVerify: { ok: boolean; stdout: string; stderr: string; code: number | null } | null = null;
    if (verifyCmd) {
      preVerify = await runShellCommand(verifyCmd, cwd, 60_000);
      if (preVerify.ok) {
        return [
          "Fix",
          `goal: ${fixGoal}`,
          verifyCmdLabel,
          "verify-broken: no (already passing)",
          "skipping fix attempt — nothing to fix.",
        ].join("\n");
      }
    }

    const { execution, reflector, rounds } = await this.executePlanWithSideEffects(plan);
    let reply = this.buildOrchestrationReply(plan, execution, reflector, { rounds, maxRounds: 3 });

    // v2 跑后 post_verify + git diff --stat；v3 加 diff_scope 校验
    if (verifyCmd) {
      const postVerify = await runShellCommand(verifyCmd, cwd, 60_000);
      const diffStat = await runShellCommand("git diff --stat HEAD", cwd, 10_000);
      const scope = diffStat.ok ? evaluateDiffScope(diffStat.stdout) : null;
      const diffScopeLine = !scope
        ? "diff-scope: skipped (git unavailable)"
        : scope.exceeded
        ? `diff-scope: ABORT (${scope.reason}) — manual review required, run \`git diff\` and \`git reset\` if not desired`
        : `diff-scope: ok (${scope.files} files, ${scope.lines} lines; max ${DIFF_SCOPE_MAX_FILES}/${DIFF_SCOPE_MAX_LINES})`;
      reply += "\n\n" + [
        "--- verify ---",
        verifyCmdLabel,
        `verify-broken (pre): yes`,
        `verify-fixed (post): ${postVerify.ok ? "yes" : "no"}`,
        ...(!postVerify.ok && postVerify.stderr.trim()
          ? [`stderr (last 200 chars): ${postVerify.stderr.trim().slice(-200)}`]
          : []),
        diffStat.ok && diffStat.stdout.trim()
          ? `diff-stat:\n${diffStat.stdout.trim()}`
          : "diff-stat: (no changes or git unavailable)",
        diffScopeLine,
      ].join("\n");
    }

    return reply;
  }

  public async runReviewCommand(prompt: string): Promise<string> {
    const reviewGoal = prompt.replace("/review", "").trim();
    if (!reviewGoal) {
      return "Usage: /review <goal>";
    }

    const reviewSkill = this.skillRegistry.get("review");
    const plan = buildOrchestrationPlan(`review ${reviewGoal}`, this.buildOrchestrationContext());
    const disallowedSkillTools = this.getDisallowedSkillToolsForPlan(plan, reviewSkill);

    if (disallowedSkillTools.length > 0) {
      return [
        "Review",
        `goal: ${reviewGoal}`,
        `skill: ${reviewSkill?.name ?? "review"}`,
        `blocked-tools: ${disallowedSkillTools.join(", ")}`,
        `reason: review lane only allows ${reviewSkill?.allowedTools.join(", ") ?? "read-only tools"}`
      ].join("\n");
    }

    // /review 是 read-only，永远单轮（多轮对 review lane 没有语义）
    const { execution, reflector } = await this.executePlanWithSideEffects(plan, { maxRounds: 1 });
    return this.buildReviewReply(plan, execution, reflector);
  }

  /**
   * L2 Session Memory · /end 命令主入口：
   *   - 跑 LLM 摘要当前对话
   *   - 写入 memory_digest 表
   *   - 返回供用户阅读的回执
   * 数据 db / channel / userId / provider 任一缺失时返回提示性消息（不写）。
   */
  public async runEndCommand(): Promise<string> {
    if (!this.dataDb) {
      return "Memory not enabled (dataDbPath disabled / vitest env). Session ends without persisting digest.";
    }
    if (!this.options.channel || !this.options.userId) {
      return "Memory requires channel + userId in QueryEngineOptions. Skipping digest.";
    }
    if (!this.currentProvider) {
      return "No provider configured; cannot summarize. Skipping digest.";
    }
    const invoker = createProviderSummarizer(this.currentProvider);
    const digest = await summarizeSession(invoker, this.messages, {
      sessionId: this.sessionId,
      channel: this.options.channel,
      userId: this.options.userId,
    });
    saveMemoryDigest(this.dataDb, digest);
    return [
      "Session ended.",
      `digest-id: ${digest.digestId}`,
      `messages: ${digest.messageCount}`,
      `summary: ${digest.summary}`,
    ].join("\n");
  }

  /**
   * /forget · 跨表 + 跨文件物理清理（W3-16）
   *   - --all：清所有 session 的 user-facing 数据 + 文件目录
   *   - --session <id>：清单一 session（跨表 + 文件目录）
   *   - --since <ms>：仅清 memory_digest（其他表/文件按时间过滤实现复杂，留 P1）
   *
   * audit_events **故意保留**——不可篡改的审计 trail；reply 里透明告知数量。
   */
  /**
   * M2-02 /remember 命令支持：把用户给的文本作 user-type 长期记忆落盘。
   * name 自动生成（user_note_<ts>）；description 取前 80 char。
   */
  public rememberQuickNote(text: string, type: MemoryType = "user"): string {
    const trimmed = text.trim();
    if (!trimmed) return "Usage: /remember <text to save as memory>";
    try {
      const entry = writeMemory(this.options.workspace, {
        name: `user_note_${Date.now()}`,
        description: trimmed.slice(0, 80),
        type,
        body: trimmed,
      });
      return `Saved memory: ${entry.name} (${entry.type})\n  → ${entry.filePath}`;
    } catch (err) {
      return `[remember] failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  public runForgetCommand(opts: ForgetOptions): string {
    if (!this.dataDb) {
      return "Memory not enabled (dataDbPath disabled / vitest env).";
    }
    const sessionsDir = this.options.sessionsDir ?? path.join(homedir(), ".codeclaw", "sessions");

    if (opts.all) {
      const r = forgetAllSessions(this.dataDb, null, sessionsDir);
      const totalRows = r.results.reduce(
        (sum, x) => sum + Object.values(x.tableRowsDeleted).reduce((s, n) => s + n, 0),
        0
      );
      const filesRemoved = r.results.filter((x) => x.fileRemoved).length;
      // M2-02：/forget --all 一并清当前项目的跨会话 memory（~/.codeclaw/projects/<hash>/memory/）
      let memoriesCleared = 0;
      try {
        memoriesCleared = clearAllMemories(this.options.workspace);
      } catch {
        /* memory dir 不存在或权限错都不阻塞 forget */
      }
      return [
        `Forgot ${r.totalSessions} session(s) (all).`,
        `  rows deleted across tables: ${totalRows}`,
        `  session dirs removed: ${filesRemoved}`,
        `  project memories cleared: ${memoriesCleared}`,
        `  audit_events preserved (compliance): see ~/.codeclaw/audit.db`,
      ].join("\n");
    }

    if (opts.sessionId) {
      const r = forgetSession(this.dataDb, null, sessionsDir, opts.sessionId);
      const totalRows = Object.values(r.tableRowsDeleted).reduce((s, n) => s + n, 0);
      return [
        `Forgot session ${opts.sessionId}.`,
        `  rows deleted: ${totalRows} (${Object.entries(r.tableRowsDeleted)
          .filter(([, n]) => n > 0)
          .map(([t, n]) => `${t}=${n}`)
          .join(", ") || "none"})`,
        `  session dir removed: ${r.fileRemoved}`,
      ].join("\n");
    }

    if (opts.since !== undefined) {
      // since 模式仅清 memory_digest（其他表按时间清需要更细设计）
      const removed = forgetMemoryDigests(this.dataDb, { since: opts.since });
      return `Forgot ${removed} digest(s) (since ${opts.since}). Note: --since only clears memory_digest in P0; cross-table since cleanup留 P1.`;
    }

    return "Forgot 0 (no opts given).";
  }

  /** 给 /orchestrate slash builtin 用 */
  public async runOrchestrateCommand(prompt: string): Promise<string> {
    const userGoal = prompt.replace("/orchestrate", "").trim();
    if (!userGoal) {
      return "Usage: /orchestrate <goal>";
    }

    const plan = buildOrchestrationPlan(userGoal, this.buildOrchestrationContext());
    const disallowedSkillTools = this.getDisallowedSkillToolsForPlan(plan);
    if (disallowedSkillTools.length > 0) {
      return [
        "Orchestration",
        `goal: ${plan.userGoal}`,
        `intent: ${plan.intent.type}`,
        `skill: ${this.activeSkill?.name ?? "none"}`,
        `blocked-tools: ${disallowedSkillTools.join(", ")}`,
        `reason: active skill only allows ${this.activeSkill?.allowedTools.join(", ") ?? "default tools"}`
      ].join("\n");
    }

    const { execution, reflector, rounds } = await this.executePlanWithSideEffects(plan);
    return this.buildOrchestrationReply(plan, execution, reflector, { rounds, maxRounds: 3 });
  }

  private buildStatusReply(): string {
    const activeApproval = this.pendingApprovals[0];
    const pending = activeApproval
      ? `${activeApproval.toolName} pending approval (${this.pendingApprovals.length} queued)`
      : "none";
    const orchestrationPending = this.pendingOrchestrationApprovals[0];

    return [
      `session: ${this.sessionId}`,
      `provider: ${this.currentProvider?.displayName ?? "not-configured"}`,
      `fallback: ${this.fallbackProvider?.displayName ?? "none"}`,
      `model: ${this.modelLabel}`,
      `vision: ${this.getRuntimeState().visionSupport}`,
      `mode: ${this.permissionMode}`,
      `workspace: ${this.options.workspace}`,
      `skill: ${this.activeSkill?.name ?? "none"}`,
      `messages: ${this.messages.length}`,
      `estimated-tokens: ${this.lastEstimatedTokens}`,
      `reactive-compacts: ${this.reactiveCompactCount}`,
      `pending-approval: ${pending}`,
      `pending-orchestration-approval: ${orchestrationPending ? `${orchestrationPending.operation} ${orchestrationPending.target} (${this.pendingOrchestrationApprovals.length} queued)` : "none"}`
    ].join("\n");
  }

  private buildUnsupportedImageInputReply(): string {
    return [
      `当前模型不支持图像理解。`,
      `provider: ${this.currentProvider?.displayName ?? "not-configured"}`,
      `model: ${this.modelLabel}`,
      `vision: ${this.getRuntimeState().visionSupport}`,
      `请切换到支持视觉的模型后再发送图片，例如 Qwen2.5-VL、LLaVA、MiniCPM-V、GLM-4V。`
    ].join("\n");
  }

  private buildUnavailableAudioTranscriptionReply(audio: {
    status: "completed" | "unavailable" | "failed";
    text?: string;
    reason?: string;
  }): string {
    return [
      audio.status === "failed" ? "语音转写失败。" : "当前未配置语音转写服务。",
      ...(audio.reason ? [`reason: ${audio.reason}`] : []),
      "请先配置 speech.asr，或直接发送文字消息。"
    ].join("\n");
  }

  private buildResumeReply(): string {
    const activeApproval = this.pendingApprovals[0];

    if (activeApproval) {
      return [
        `Recovered work is waiting for approval.`,
        `pending approvals: ${this.pendingApprovals.length}`,
        `tool: ${activeApproval.toolName}`,
        `detail: ${activeApproval.detail}`,
        `reason: ${activeApproval.reason}`,
        `Run /approve or /deny.`
      ].join("\n");
    }

    return [
      `session: ${this.sessionId}`,
      `messages: ${this.messages.length}`,
      `provider: ${this.currentProvider?.displayName ?? "not-configured"}`,
      `mode: ${this.permissionMode}`,
      `No pending approval.`
    ].join("\n");
  }

  private buildSessionReply(): string {
    const lastAssistantMessage = [...this.messages].reverse().find((message) => message.role === "assistant");

    return [
      `session: ${this.sessionId}`,
      `messages: ${this.messages.length}`,
      `active-skill: ${this.activeSkill?.name ?? "none"}`,
      `last-assistant-message: ${lastAssistantMessage?.text.slice(0, 120) ?? "none"}`
    ].join("\n");
  }

  private buildProvidersReply(): string {
    return [
      `current: ${this.currentProvider?.displayName ?? "not-configured"} (${this.currentProvider?.model ?? "-"})`,
      `fallback: ${this.fallbackProvider?.displayName ?? "none"} (${this.fallbackProvider?.model ?? "-"})`
    ].join("\n");
  }

  private buildApprovalsReply(): string {
    if (this.pendingApprovals.length === 0 && this.pendingOrchestrationApprovals.length === 0) {
      return "No pending approvals.";
    }

    return [
      `pending approvals: ${this.pendingApprovals.length + this.pendingOrchestrationApprovals.length}`,
      ...this.pendingApprovals.map(
        (approval, index) =>
          `${index + 1}. ${approval.id}  ${approval.toolName}  ${sanitizeForDisplay(approval.detail)}  ${sanitizeForDisplay(approval.reason)}`
      ),
      ...this.pendingOrchestrationApprovals.map(
        (approval, index) =>
          `${this.pendingApprovals.length + index + 1}. ${approval.id}  orchestration:${approval.operation}  ${sanitizeForDisplay(approval.target)}  ${sanitizeForDisplay(approval.reason)}`
      )
    ].join("\n");
  }

  private buildContextReply(): string {
    const turns = this.messages.filter((message) => message.role !== "system").length;
    const chars = this.messages.reduce((sum, message) => sum + message.text.length, 0);

    return [
      `turns: ${turns}`,
      `messages: ${this.messages.length}`,
      `characters: ${chars}`,
      `estimated-tokens: ${this.lastEstimatedTokens}`,
      `auto-compact-threshold: ${this.getAutoCompactThreshold()}`,
      `auto-compacts: ${this.autoCompactCount}`,
      `reactive-compacts: ${this.reactiveCompactCount}`,
      `compact: ${this.compactCount > 0 ? `active (#${this.compactCount}, last compacted ${this.lastCompactedMessageCount} messages)` : "inactive"}`,
      `compact-summary: ${this.lastCompactSummary ? clipLine(this.lastCompactSummary, 80) : "none"}`
    ].join("\n");
  }

  private buildMemoryReply(): string {
    return [
      `l1: in-memory transcript active`,
      `l2: session persistence not implemented`,
      `l3: codebase retrieval not implemented`,
      `recent-reads: ${this.recentReadFiles.size > 0 ? [...this.recentReadFiles].slice(-5).join(", ") : "none"}`,
      `changed-files: ${this.changedFiles.size > 0 ? [...this.changedFiles].slice(-5).join(", ") : "none"}`
    ].join("\n");
  }

  private buildDiffReply(): string {
    if (this.changedFiles.size === 0) {
      return "No tracked file edits in this session.";
    }

    return [
      `tracked edits: ${this.changedFiles.size}`,
      ...[...this.changedFiles].map((file, index) => `${index + 1}. ${file}`),
      "Note: this scaffold currently reports session-tracked edits instead of a git patch."
    ].join("\n");
  }

  private buildSkillsReply(prompt: string): string {
    const suffix = prompt.slice("/skills".length).trim();

    if (!suffix) {
      const skills = this.skillRegistry.list();
      return [
        `active-skill: ${this.activeSkill?.name ?? "none"}`,
        `discovered-skills: ${skills.length}`,
        ...skills.map((skill) => `- ${formatSkill(skill)}`),
        "Use `/skills use <name>` to activate a skill or `/skills clear` to return to the default flow."
      ].join("\n");
    }

    if (suffix === "clear") {
      this.activeSkill = null;
      return "Cleared active skill. Returning to the default flow.";
    }

    if (suffix.startsWith("use ")) {
      const requestedSkill = suffix.slice("use ".length).trim();
      if (!requestedSkill) {
        return "Usage: /skills use <name>";
      }

      const skill = this.skillRegistry.get(requestedSkill);
      if (!skill) {
        return `Unknown skill: ${requestedSkill}\nAvailable: ${this.skillRegistry.list().map((item) => item.name).join(", ")}`;
      }

      this.activeSkill = skill;
      return [
        `Activated skill: ${skill.name}`,
        skill.description,
        `allowed-tools: ${skill.allowedTools.join(", ")}`
      ].join("\n");
    }

    return "Usage: /skills, /skills use <name>, /skills clear";
  }

  private buildHooksReply(): string {
    return [
      "hooks: none configured",
      "Supported hook integration is deferred past Phase 1."
    ].join("\n");
  }

  private buildInitReply(): string {
    return [
      `workspace: ${this.options.workspace}`,
      `provider: ${this.currentProvider?.displayName ?? "not-configured"}`,
      `mode: ${this.permissionMode}`,
      "Bootstrap checklist:",
      "1. Run `codeclaw setup` to configure providers.",
      "2. Use `/mode auto` or `/mode acceptEdits` when you want non-blocking edits.",
      "3. Start with `/read`, `/glob`, `/symbol`, `/definition`, `/references`, `/plan`, `/orchestrate`, `/bash`, or a normal prompt."
    ].join("\n");
  }

  private buildSummaryReply(): string {
    const compactCandidates = this.messages.slice(1);
    const summary = compactCandidates.length > 0 ? this.buildCompactSummary(compactCandidates) : "No transcript to summarize yet.";

    return [
      "Summary",
      `session: ${this.sessionId}`,
      `skill: ${this.activeSkill?.name ?? "none"}`,
      `messages: ${this.messages.length}`,
      summary
    ].join("\n");
  }

  private async handleExportCommand(prompt: string): Promise<string> {
    const requestedPath = prompt.replace("/export", "").trim();
    const target = requestedPath || `codeclaw-session-${this.sessionId}.md`;
    const absoluteTarget = resolveWorkspaceTarget(this.options.workspace, target);
    const content = buildTranscriptMarkdown(this.messages);
    await mkdir(path.dirname(absoluteTarget), { recursive: true });
    await writeFile(absoluteTarget, `${content}\n`, "utf8");

    return [
      "Export complete.",
      `path: ${absoluteTarget}`,
      `messages: ${this.messages.length}`
    ].join("\n");
  }

  private buildReloadPluginsReply(): string {
    const discoveredSkills = this.skillRegistry.list();
    return [
      "Plugin reload complete.",
      "local-plugins: 0",
      `builtin-skills: ${discoveredSkills.length}`,
      `active-skill: ${this.activeSkill?.name ?? "none"}`
    ].join("\n");
  }

  private buildDebugToolCallReply(prompt: string): string {
    const command = prompt.replace("/debug-tool-call", "").trim();
    if (!command) {
      return "Usage: /debug-tool-call <command>";
    }

    const toolName = detectLocalTool(command);
    if (!toolName) {
      return `not-a-local-tool: ${command}`;
    }

    const inspection = inspectLocalTool(command, this.permissions);
    const skillAllowed = this.isToolAllowedByActiveSkill(toolName);

    return [
      "Debug Tool Call",
      `prompt: ${command}`,
      `tool: ${toolName}`,
      `detail: ${inspection.detail ?? "-"}`,
      `permission-behavior: ${inspection.decision?.behavior ?? "unknown"}`,
      `permission-reason: ${inspection.decision?.reason ?? "none"}`,
      `active-skill: ${this.activeSkill?.name ?? "none"}`,
      `skill-allows-tool: ${skillAllowed ? "yes" : "no"}`
    ].join("\n");
  }

  private async handleMcpCommand(prompt: string): Promise<string> {
    const suffix = prompt.slice("/mcp".length).trim();
    if (!suffix) {
      const servers = await listMcpServers(this.options.workspace);
      return [
        "MCP",
        `servers: ${servers.length}`,
        ...servers.map((server) => `- ${server.name} (${server.transport}, ${server.status}) tools=${server.toolCount} resources=${server.resourceCount}`),
        "Commands: /mcp resources <server>, /mcp tools <server>, /mcp read <server> <resource>, /mcp call <server> <tool> <input>"
      ].join("\n");
    }

    const [subcommand, ...rest] = suffix.split(/\s+/);
    if (subcommand === "resources") {
      const serverName = rest[0] ?? "workspace-mcp";
      const resources = await listMcpResources(this.options.workspace, serverName);
      return [
        "MCP Resources",
        `server: ${serverName}`,
        ...resources.map((resource) => `- ${resource.uri} (${resource.name}) ${resource.description}`)
      ].join("\n");
    }

    if (subcommand === "tools") {
      const serverName = rest[0] ?? "workspace-mcp";
      const tools = listMcpTools(serverName);
      return [
        "MCP Tools",
        `server: ${serverName}`,
        ...tools.map((tool) => `- ${tool.name} ${tool.description}`)
      ].join("\n");
    }

    if (subcommand === "read") {
      const serverName = rest[0];
      const resource = rest[1];
      if (!serverName || !resource) {
        return "Usage: /mcp read <server> <resource>";
      }

      const decision = this.permissions.evaluate({
        tool: "mcp-read",
        server: serverName,
        resource
      });
      if (decision.behavior === "deny") {
        return `MCP read blocked: ${decision.reason}`;
      }

      const content = await readMcpResource(this.options.workspace, serverName, resource);
      return [
        "MCP Resource",
        `server: ${serverName}`,
        `resource: ${resource}`,
        "",
        content
      ].join("\n");
    }

    if (subcommand === "call") {
      const serverName = rest[0];
      const toolName = rest[1];
      const input = rest.slice(2).join(" ");
      if (!serverName || !toolName) {
        return "Usage: /mcp call <server> <tool> <input>";
      }

      const decision = this.permissions.evaluate({
        tool: "mcp-call",
        server: serverName,
        toolName
      });
      if (decision.behavior !== "allow") {
        return decision.behavior === "ask"
          ? `MCP tool call requires approval in mode ${this.permissionMode}. Switch to /mode auto or /mode acceptEdits to execute.\nserver: ${serverName}\ntool: ${toolName}`
          : `MCP tool call blocked: ${decision.reason}`;
      }

      const output = await callMcpTool(this.options.workspace, serverName, toolName, input);
      return [
        "MCP Tool",
        `server: ${serverName}`,
        `tool: ${toolName}`,
        "",
        output
      ].join("\n");
    }

    return "Usage: /mcp, /mcp resources <server>, /mcp tools <server>, /mcp read <server> <resource>, /mcp call <server> <tool> <input>";
  }

  private async handleWechatCommand(prompt: string): Promise<string> {
    this.options.wechat?.attachCurrentSession?.();

    const loginManager = this.options.wechat?.loginManager;
    if (!loginManager) {
      return "WeChat login is not configured. Set gateway.bots.ilinkWechat.tokenFile and start the CLI again.";
    }

    const suffix = prompt.slice("/wechat".length).trim();
    if (suffix === "status") {
      return formatWechatLoginState(await loginManager.refreshStatus());
    }
    if (suffix === "refresh" || suffix === "restart") {
      const refreshed = loginManager.restart ? await loginManager.restart() : await loginManager.ensureStarted();
      return [
        formatWechatLoginState(refreshed),
        "",
        "Generated a fresh WeChat login QR code. Scan it soon, or run /wechat refresh again."
      ].join("\n");
    }

    const current = await loginManager.refreshStatus();
    if (current.phase === "confirmed") {
      return formatWechatLoginState(current);
    }

    const started = await loginManager.ensureStarted();
    const guidance =
      started.phase === "waiting" || started.phase === "scanned"
        ? "Use WeChat to scan the QR code. Run /wechat status to refresh login state."
        : "Run /wechat status after fixing the connection or configuration.";

    return [formatWechatLoginState(started), "", guidance].join("\n");
  }

  private isToolAllowedByActiveSkill(toolName: LocalToolName): boolean {
    return this.activeSkill ? this.activeSkill.allowedTools.includes(toolName) : true;
  }

  private buildSkillToolBlockReply(toolName: LocalToolName): string {
    if (!this.activeSkill) {
      return `${toolName} blocked: permission denied`;
    }

    return `Skill ${this.activeSkill.name} blocks ${toolName}. Allowed tools: ${this.activeSkill.allowedTools.join(", ")}`;
  }

  private getDisallowedSkillToolsForPlan(plan: OrchestrationPlan, skillOverride?: SkillDefinition | null): LocalToolName[] {
    const effectiveSkill = skillOverride ?? this.activeSkill;
    if (!effectiveSkill) {
      return [];
    }

    return unique(
      plan.goals
        .flatMap((goal) => goal.actions.map((action) => actionToRequiredTool(action)))
        .filter((toolName) => !effectiveSkill.allowedTools.includes(toolName))
    );
  }

  private buildOrchestrationContext(): OrchestrationContext {
    return {
      workspace: this.options.workspace,
      currentProvider: this.currentProvider,
      permissionMode: this.permissionMode
    };
  }

  /**
   * 给 /cost slash builtin 用：当前会话的活动快照。
   *
   * 注：当前只有"本地估算 token"（按字符 / 4），没有 provider 真实用量。
   * 真实 input/output tokens 与价位换算落到 P0 W3 provider client 改造后。
   */
  /** #86：调 LLM 前 evaluate；无 dataDb 或无配置 → 返 null（不门控） */
  private evaluateBudgetGate(): import("../provider/budget").BudgetVerdict | null {
    if (!this.dataDb) return null;
    if (Object.keys(this.budgetConfig).length === 0) return null;
    try {
      const session = summarizeBySession(this.dataDb, this.sessionId);
      const today = summarizeToday(this.dataDb);
      return evaluateBudget({ config: this.budgetConfig, session, today });
    } catch {
      return null;
    }
  }

  public runCostCommand(): string {
    const session = this.sessionId;
    const provider = this.currentProvider?.displayName ?? "not-configured";
    const model = this.modelLabel;
    const messages = this.messages.length;
    const userMessages = this.messages.filter((m) => m.role === "user").length;
    const assistantMessages = this.messages.filter((m) => m.role === "assistant").length;
    const estimatedTokens = this.lastEstimatedTokens;
    const compacts = this.compactCount;
    const reactiveCompacts = this.reactiveCompactCount;
    const filesRead = this.recentReadFiles.size;
    const filesChanged = this.changedFiles.size;
    const pendingTool = this.pendingApprovals.length;
    const pendingOrch = this.pendingOrchestrationApprovals.length;
    const fsm = this.fsm.snapshot();
    // /cost 自身就是这一轮的 executing 阶段；显示当前 phase 容易误读"卡住"。
    // 改写：
    //   - "this turn (#N): <phase>" 表明当前轮在哪个 phase（多数情况是 executing）
    //   - "last completed turn: <reason>/<completion>" 才是用户真正关心的"上一轮怎么收的"
    const turnLine = `current turn: #${fsm.turn} phase=${fsm.phase} (this is /cost itself running)`;
    const haltLine = fsm.lastHalt
      ? `last-completed-turn: reason=${fsm.lastHalt.reason} completion=${fsm.lastHalt.completion}` +
        (fsm.lastHalt.message ? ` message="${fsm.lastHalt.message}"` : "")
      : "last-completed-turn: none yet (this is the first turn)";

    // W3-05：provider 真实 token 用量
    const totalTokens = this.sessionInputTokens + this.sessionOutputTokens;
    const usageLine = totalTokens > 0
      ? `provider-tokens: input=${this.sessionInputTokens} output=${this.sessionOutputTokens} total=${totalTokens}` +
        (this.lastProviderModelId ? ` (last-model=${this.lastProviderModelId})` : "")
      : "provider-tokens: 0 (no LLM round-trip yet — try sending a non-slash message)";

    // W3-17：USD cost 累计（dataDb 可用时查 llm_calls_raw）
    const costLines: string[] = [];
    if (this.dataDb) {
      try {
        const sessionCost = summarizeBySession(this.dataDb, this.sessionId);
        const todayCost = summarizeToday(this.dataDb);
        if (sessionCost.callCount > 0 || todayCost.callCount > 0) {
          costLines.push(
            `session-cost: ${formatUsd(sessionCost.totalUsdCost)} (${sessionCost.callCount} call(s))`,
            `today-cost: ${formatUsd(todayCost.totalUsdCost)} (${todayCost.callCount} call(s) across all sessions)`
          );
        }
      } catch {
        // ignore cost summary failures
      }
    }

    // #86：budget 状态（如配置了）
    if (Object.keys(this.budgetConfig).length > 0) {
      costLines.push("---");
      costLines.push(formatBudgetConfig(this.budgetConfig));
      const verdict = this.evaluateBudgetGate();
      if (verdict) {
        const marker = verdict.status === "exceeded" ? "✗" : verdict.status === "warn" ? "⚠" : "✓";
        costLines.push(`budget-status: ${marker} ${verdict.status} · ${verdict.detail}`);
        if (verdict.shouldBlock) {
          costLines.push("budget-action: NEXT LLM CALL WILL BE BLOCKED (onExceeded='block')");
        }
      }
    }

    return [
      "Cost & Activity Snapshot",
      `session: ${session}`,
      `provider: ${provider}`,
      `model: ${model}`,
      turnLine,
      haltLine,
      `messages: ${messages}  (user=${userMessages}, assistant=${assistantMessages})`,
      usageLine,
      ...costLines,
      `estimated-tokens (local heuristic, char/4): ${estimatedTokens}`,
      `compacts: ${compacts}  (reactive=${reactiveCompacts})`,
      `files-read: ${filesRead}`,
      `files-changed: ${filesChanged}`,
      `pending-tool-approvals: ${pendingTool}`,
      `pending-orchestration-approvals: ${pendingOrch}`,
    ].join("\n");
  }

  /**
   * 给 /ask slash builtin 用：把 permission mode 一次性切到 plan 让用户做 read-only Q&A。
   *
   * 语义：
   *   - 本次 /ask 调用本身不做 restore；下一轮非 /ask 的 turn 跑完后 restore 回原 mode。
   *   - 已 armed 状态下重复 /ask 不重复保存（避免把"plan"当原 mode 保存导致永远卡 plan）。
   *   - 限制（v1）：/ask <question> 形式不会自动注入问题，仍需用户在下一行重新输入；
   *     提示里把问题原文回显给用户便于复制。
   */
  public runAskCommand(prompt: string): string {
    const goal = prompt.replace(/^\/ask\s*/, "").trim();
    if (this.askModePending) {
      const restoreTo = this.askModePending.restore;
      const tail = goal
        ? `\nQuestion you typed: ${goal}\nJust hit enter / submit it as your next prompt.`
        : "";
      return `Plan-mode Q&A is already armed (will restore to "${restoreTo}").${tail}`;
    }
    this.askModePending = { restore: this.permissionMode };
    this.permissionMode = "plan";
    this.permissions.setMode("plan");
    if (goal) {
      return [
        `Plan mode armed for read-only Q&A. Submit your question on the next line:`,
        `  > ${goal}`,
        `(Mode will restore to "${this.askModePending.restore}" after the next answer.)`,
      ].join("\n");
    }
    return [
      `Plan mode armed for read-only Q&A. Type your question on the next line.`,
      `(Mode will restore to "${this.askModePending.restore}" after the next answer.)`,
    ].join("\n");
  }

  /** 给 /plan slash builtin 用：解析 prompt → 构造 plan → 渲染 */
  public runPlanCommand(prompt: string): string {
    const userGoal = prompt.replace("/plan", "").trim();
    if (!userGoal) {
      return "Usage: /plan <goal>";
    }
    const plan = buildOrchestrationPlan(userGoal, this.buildOrchestrationContext());
    return this.buildPlanReply(plan);
  }

  private buildPlanReply(plan: OrchestrationPlan): string {
    return [
      "Planner",
      `goal: ${plan.userGoal}`,
      `intent: ${plan.intent.type} (confidence ${plan.intent.confidence.toFixed(2)})`,
      `strategy: ${plan.strategy.type} - ${plan.strategy.detail}`,
      buildWriteLaneAssessment(plan, this.permissionMode),
      `goals: ${plan.goals.length}`,
      ...plan.goals.map(formatGoal)
    ].join("\n");
  }

  private buildOrchestrationReply(
    plan: OrchestrationPlan,
    execution: ExecutionResult,
    reflector: ReflectorResult,
    meta: { rounds?: number; maxRounds?: number } = {}
  ): string {
    // 显示 rounds 信息：让用户从输出里看到走了几轮 + 是否 hit max-turns
    const roundsLine = meta.rounds !== undefined
      ? meta.maxRounds !== undefined
        ? `rounds: ${meta.rounds}/${meta.maxRounds}${meta.rounds >= meta.maxRounds && reflector.decision === "replan" ? " (max-turns reached)" : ""}`
        : `rounds: ${meta.rounds}`
      : null;
    return [
      "Orchestration",
      `goal: ${plan.userGoal}`,
      `intent: ${plan.intent.type}`,
      `strategy: ${plan.strategy.type}`,
      ...(roundsLine ? [roundsLine] : []),
      `checks-run: ${execution.cost.checksRun}`,
      `completed-goals: ${execution.completed.length}`,
      `failed-goals: ${execution.failed.length}`,
      `duration-ms: ${execution.duration}`,
      buildWriteLaneAssessment(plan, this.permissionMode),
      execution.observations.length > 0
        ? `observations: ${execution.observations.map(formatObservation).join(" | ")}`
        : "observations: none",
      execution.gaps.length > 0
        ? `gaps: ${execution.gaps.map((gap) => `${gap.goalId} ${gap.description}`).join(" | ")}`
        : "gaps: none",
      `actions-run: ${execution.actionLogs.length}`,
      execution.actionLogs.length > 0 ? `action-logs: ${execution.actionLogs.join(" | ")}` : "action-logs: none",
      `approval-requests: ${execution.approvalRequests.length > 0 ? execution.approvalRequests.map((request) => `${request.id} ${request.operation} ${request.target} (${request.status})`).join(" | ") : "none"}`,
      `reflector-decision: ${reflector.decision}`,
      `is-complete: ${reflector.isComplete ? "yes" : "no"}`,
      reflector.newGoals.length > 0
        ? `next-goals: ${reflector.newGoals.map((goal) => goal.description).join(" | ")}`
        : "next-goals: none"
    ].join("\n");
  }

  private buildReviewReply(
    plan: OrchestrationPlan,
    execution: ExecutionResult,
    reflector: ReflectorResult
  ): string {
    return [
      "Review",
      `goal: ${plan.userGoal}`,
      "skill: review",
      `checks-run: ${execution.cost.checksRun}`,
      `failed-goals: ${execution.failed.length}`,
      execution.actionLogs.length > 0 ? `action-logs: ${execution.actionLogs.join(" | ")}` : "action-logs: none",
      execution.gaps.length > 0
        ? `findings: ${execution.gaps.map((gap) => `${gap.description} (${gap.rootCause})`).join(" | ")}`
        : "findings: no explicit gaps detected",
      `reflector-decision: ${reflector.decision}`
    ].join("\n");
  }

  private buildOrchestrationApprovalDecisionReply(
    approval: PendingOrchestrationApproval,
    outcome: "approved" | "denied",
    executionOutput?: string
  ): string {
    const reflector = reflectOnApprovalOutcome(approval, outcome);

    return [
      `${outcome === "approved" ? "Approved" : "Denied"} orchestration ${approval.operation}: ${approval.target}`,
      `original-goal: ${approval.planGoal}`,
      executionOutput ? `tool-output: ${clipLine(executionOutput, 200)}` : "tool-output: none",
      `reflector-decision: ${reflector.decision}`,
      reflector.gaps.length > 0
        ? `gaps: ${reflector.gaps.map((gap) => `${gap.description} (${gap.rootCause})`).join(" | ")}`
        : "gaps: none",
      reflector.newGoals.length > 0
        ? `next-goals: ${reflector.newGoals.map((goal) => goal.description).join(" | ")}`
        : "next-goals: none"
    ].join("\n");
  }

  private handleModelCommand(prompt: string): string {
    const nextModel = prompt.replace("/model", "").trim();

    if (!nextModel) {
      return `current model: ${this.modelLabel}`;
    }

    this.modelLabel = nextModel;
    if (this.currentProvider) {
      this.currentProvider = {
        ...this.currentProvider,
        model: nextModel
      };
    }

    return `model set to ${nextModel}`;
  }

  /** 给 /mode slash builtin 用（公共入口，统一含审计） */
  public runModeCommand(prompt: string): string {
    const nextMode = prompt.replace("/mode", "").trim();

    if (!nextMode) {
      return `current mode: ${this.permissionMode}`;
    }

    if (!PERMISSION_MODES.includes(nextMode as PermissionMode)) {
      return `unknown mode: ${nextMode}\navailable: ${PERMISSION_MODES.join(", ")}`;
    }

    const previousMode = this.permissionMode;
    this.permissionMode = nextMode as PermissionMode;
    this.permissions.setMode(this.permissionMode);
    // W3-01：mode 切换是可审计行为
    this.audit({
      actor: "user",
      action: "permission.mode-change",
      decision: "allow",
      resource: this.permissionMode,
      reason: `mode ${previousMode} → ${this.permissionMode}`,
      details: { from: previousMode, to: this.permissionMode },
    });
    return `mode set to ${this.permissionMode}`;
  }

  private handleCompactCommand(prompt: string): string {
    const rawKeepRecent = prompt.replace("/compact", "").trim();
    const parsedKeepRecent = rawKeepRecent ? Number.parseInt(rawKeepRecent, 10) : Number.NaN;
    const keepRecent = Number.isFinite(parsedKeepRecent) && parsedKeepRecent > 1
      ? parsedKeepRecent
      : DEFAULT_COMPACT_KEEP_RECENT_MESSAGES;
    const compactResult = this.performCompact(keepRecent);

    if (!compactResult) {
      return `Not enough context to compact yet. messages: ${this.messages.length}`;
    }

    return [
      `Compacted ${compactResult.compactedMessageCount} messages into summary #${this.compactCount}.`,
      `Preserved recent messages: ${compactResult.preservedRecentCount}.`,
      `Summary now tracks goals, key files, and open items.`
    ].join("\n");
  }

  private maybeAutoCompact():
    | {
        compactedMessageCount: number;
        preservedRecentCount: number;
      }
    | null {
    if (this.lastEstimatedTokens < this.getAutoCompactThreshold()) {
      return null;
    }

    const compactResult = this.performCompact(DEFAULT_COMPACT_KEEP_RECENT_MESSAGES);
    if (!compactResult) {
      return null;
    }

    this.autoCompactCount += 1;
    return compactResult;
  }

  private performCompact(keepRecent: number):
    | {
        compactedMessageCount: number;
        preservedRecentCount: number;
      }
    | null {
    const preservedPrefixCount = 1;
    const compactUntilIndex = Math.max(preservedPrefixCount, this.messages.length - keepRecent);
    const compactCandidates = this.messages.slice(preservedPrefixCount, compactUntilIndex);

    if (compactCandidates.length < 2) {
      return null;
    }

    const preservedTail = this.messages.slice(compactUntilIndex);
    const summaryBody = this.buildCompactSummary(compactCandidates);
    const summaryMessage: EngineMessage = {
      id: createId("msg"),
      role: "assistant",
      text: `[compact summary #${this.compactCount + 1}]\n${summaryBody}`,
      source: "summary"
    };

    this.messages.splice(
      preservedPrefixCount,
      this.messages.length - preservedPrefixCount,
      summaryMessage,
      ...preservedTail
    );

    this.compactCount += 1;
    this.lastCompactedMessageCount = compactCandidates.length;
    this.lastCompactSummary = summaryBody;
    this.lastEstimatedTokens = estimateMessageTokens(this.messages);

    return {
      compactedMessageCount: compactCandidates.length,
      preservedRecentCount: preservedTail.length
    };
  }

  private buildCompactSummary(messages: EngineMessage[]): string {
    const nonCommandUserMessages = messages
      .filter((message) => message.role === "user")
      .map((message) => clipLine(message.text))
      .filter((text) => text && !text.startsWith("/"));
    const goals = unique(nonCommandUserMessages.slice(-MAX_COMPACT_LIST_ITEMS));
    const files = unique(
      messages.flatMap((message) => extractFilePaths(message.text))
    ).slice(0, MAX_COMPACT_LIST_ITEMS);
    const openItems = unique([
      ...messages
        .filter((message) =>
          message.text.includes("Approval required") ||
          message.text.includes("blocked:") ||
          message.text.includes("[stream interrupted:") ||
          message.text.includes("Provider request failed")
        )
        .map((message) => clipLine(message.text)),
      ...nonCommandUserMessages.slice(-2).map((message) => `Continue from: ${message}`)
    ]).slice(0, MAX_COMPACT_LIST_ITEMS);

    return [
      "Summary generated from older transcript.",
      `Compacted messages: ${messages.length}`,
      "Goals:",
      ...(goals.length > 0 ? goals.map((goal) => `- ${goal}`) : ["- No explicit goal captured"]),
      "Key files:",
      ...(files.length > 0 ? files.map((file) => `- ${file}`) : ["- No file references captured"]),
      "Open items:",
      ...(openItems.length > 0 ? openItems.map((item) => `- ${item}`) : ["- Continue from the latest preserved turn"])
    ].join("\n");
  }

  interrupt(): void {
    this.interrupted = true;
    this.abortController?.abort();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getMessages(): EngineMessage[] {
    return [...this.messages];
  }

  getPendingApproval(): PendingApprovalView | null {
    const activeApproval = this.pendingApprovals[0];

    if (!activeApproval) {
      return null;
    }

    return {
      id: activeApproval.id,
      toolName: activeApproval.toolName,
      detail: activeApproval.detail,
      reason: activeApproval.reason,
      queuePosition: 1,
      totalPending: this.pendingApprovals.length
    };
  }

  getChannelSnapshot(): ChannelSessionSnapshot {
    const pendingApproval = this.getPendingApproval();
    const pendingOrchestrationApproval = this.pendingOrchestrationApprovals[0]
      ? {
          id: this.pendingOrchestrationApprovals[0].id,
          operation: this.pendingOrchestrationApprovals[0].operation,
          target: this.pendingOrchestrationApprovals[0].target,
          reason: this.pendingOrchestrationApprovals[0].reason,
          queuePosition: 1,
          totalPending: this.pendingOrchestrationApprovals.length
        } satisfies PendingOrchestrationApprovalView
      : null;

    return {
      sessionId: this.sessionId,
      messages: this.getMessages(),
      pendingApproval,
      pendingOrchestrationApproval,
      runtime: this.getRuntimeState()
    };
  }

  private takePendingApproval(targetId: string | null): PendingApproval | null {
    if (this.pendingApprovals.length === 0) {
      return null;
    }

    if (!targetId) {
      return this.pendingApprovals.shift() ?? null;
    }

    const approvalIndex = this.pendingApprovals.findIndex((approval) => approval.id === targetId);
    if (approvalIndex < 0) {
      return null;
    }

    const [approval] = this.pendingApprovals.splice(approvalIndex, 1);
    return approval ?? null;
  }

  private takePendingOrchestrationApproval(targetId: string | null): PendingOrchestrationApproval | null {
    if (this.pendingOrchestrationApprovals.length === 0) {
      return null;
    }

    if (!targetId) {
      return this.pendingOrchestrationApprovals.shift() ?? null;
    }

    const approvalIndex = this.pendingOrchestrationApprovals.findIndex((approval) => approval.id === targetId);
    if (approvalIndex < 0) {
      return null;
    }

    const [approval] = this.pendingOrchestrationApprovals.splice(approvalIndex, 1);
    return approval ?? null;
  }

  private persistPendingApprovals(): void {
    if (this.pendingApprovals.length === 0) {
      clearPendingApprovals(this.options.approvalsDir, { sessionId: this.sessionId });
      return;
    }

    // W3-03：save 不显式传 sessionId — store 内部从 list 推断（list 内全部同 session
    // 就按它过滤；recovery 后 list 混合 sessionId 就退回老的全删行为）。这一折中
    // 在并发场景隔离、recovery 场景全集替换都是正确的，参见 store.ts 头部注释。
    savePendingApprovals(
      this.options.approvalsDir,
      this.pendingApprovals as StoredPendingApproval[]
    );
  }

  private getAutoCompactThreshold(): number {
    return this.options.autoCompactThreshold ?? DEFAULT_AUTO_COMPACT_THRESHOLD;
  }

  private shouldReactiveCompact(error: Error): boolean {
    if (error instanceof ProviderRequestError && error.statusCode === 413) {
      return true;
    }

    const message = [error.message, error instanceof ProviderRequestError ? error.responseBody : ""]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return (
      message.includes("context") &&
      (message.includes("too long") || message.includes("length") || message.includes("limit"))
    );
  }

  /**
   * M1-B.2：把 toolRegistry 投影成 streamProviderResponse 与 token budget 估算
   * 共享的 {name, description, inputSchema} 形状。注：仅在 hasNativeTools 时调用。
   */
  private buildStreamToolSchemas(): ToolSchemaSpec[] {
    // M2-03：plan mode 时只暴露 read-only + memory_write + ExitPlanMode；
    // 其他模式全量。listForMode 内部硬编码白名单。
    return this.toolRegistry.listForMode(this.permissionMode).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  private getProviderMessages(): EngineMessage[] {
    const providerMessages = this.messages.filter((message) => {
      if (message.role === "user") {
        return message.source === "user";
      }

      if (message.role === "assistant") {
        return message.source === "model" || message.source === "summary";
      }

      // M1-B.2：role:"tool" 消息也保留，作为下一轮 LLM 上下文（含 toolCallId）
      if (message.role === "tool") {
        return true;
      }

      return false;
    });

    // M1-A：CODECLAW_AGENT_GRADE=false 紧急回退到旧 skill-prompt-injection 路径
    const agentGradeOff = process.env.CODECLAW_AGENT_GRADE === "false";

    if (agentGradeOff) {
      if (!this.activeSkill) {
        return providerMessages;
      }
      const firstUserIndex = providerMessages.findIndex((message) => message.role === "user");
      if (firstUserIndex < 0) {
        return providerMessages;
      }
      return providerMessages.map((message, index) =>
        index === firstUserIndex
          ? {
              ...message,
              text: injectSkillPrompt(this.activeSkill as SkillDefinition, message.text)
            }
          : message
      );
    }

    // M1-A 默认路径：在头部插 system message
    const systemText = buildSystemPrompt({
      workspace: this.options.workspace,
      permissionMode: this.permissionMode,
      provider: this.currentProvider,
      slashRegistry: this.slashRegistry,
      skillRegistry: this.skillRegistry,
      activeSkill: this.activeSkill,
      // toolRegistry 在 M1-B 接入；空缺不影响 prompt 构造
    });
    const systemMessage: EngineMessage = {
      id: createId("system"),
      role: "system",
      text: systemText,
      source: "local"
    };
    return [systemMessage, ...providerMessages];
  }

  private buildProviderFailureMessage(error: Error): string {
    if (!(error instanceof ProviderRequestError)) {
      return `Provider request failed: ${error.message}`;
    }

    const detail = error.responseBody?.replace(/\s+/g, " ").trim();
    const clippedDetail =
      detail && detail.length > 240 ? `${detail.slice(0, 237)}...` : detail;

    return clippedDetail
      ? `Provider request failed: ${error.message}\nprovider-detail: ${clippedDetail}`
      : `Provider request failed: ${error.message}`;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setModel(model: string): void {
    this.modelLabel = model;
    if (this.currentProvider) {
      this.currentProvider = {
        ...this.currentProvider,
        model
      };
    }
  }

  getRuntimeState(): {
    modelLabel: string;
    permissionMode: PermissionMode;
    providerLabel: string;
    fallbackProviderLabel: string;
    activeSkillName: string | null;
    visionSupport: "supported" | "unsupported" | "unknown";
    visionReason: string;
  } {
    const capabilities = detectProviderCapabilities(this.currentProvider);
    return {
      modelLabel: this.modelLabel,
      permissionMode: this.permissionMode,
      providerLabel: this.currentProvider?.displayName ?? "not-configured",
      fallbackProviderLabel: this.fallbackProvider?.displayName ?? "none",
      activeSkillName: this.activeSkill?.name ?? null,
      visionSupport: capabilities.vision,
      visionReason: capabilities.reason
    };
  }

  getReadFileState(): Record<string, never> {
    return {};
  }

  private recordToolActivity(toolName: LocalToolName, detail: string, output: string): void {
    if (toolName === "read" && detail) {
      this.recentReadFiles.add(detail);
      return;
    }

    if (toolName === "glob") {
      for (const line of output.split("\n").slice(2)) {
        const trimmed = line.trim();
        if (trimmed) {
          this.recentReadFiles.add(trimmed);
        }
      }
      return;
    }

    if (toolName === "write" || toolName === "append" || toolName === "replace") {
      if (detail) {
        this.changedFiles.add(detail);
      }
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function createQueryEngine(options: QueryEngineOptions): QueryEngine {
  return new LocalQueryEngine({
    ...options
  });
}
