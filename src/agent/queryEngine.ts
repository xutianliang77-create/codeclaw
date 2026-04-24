import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { clearPendingApprovals, loadPendingApprovals, savePendingApprovals } from "../approvals/store";
import type { StoredPendingApproval } from "../approvals/store";
import { runDoctor } from "../commands/doctor";
import type { PermissionMode } from "../lib/config";
import { callMcpTool, listMcpResources, listMcpServers, listMcpTools, readMcpResource } from "../mcp/service";
import { SlashRegistry, loadBuiltins } from "../commands/slash";
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
import { detectProviderCapabilities } from "../provider/capabilities";
import type { ProviderStatus } from "../provider/types";
import { createSkillRegistry } from "../skills/registry";
import type { SkillDefinition } from "../skills/registry";
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

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildBuiltinReply(prompt: string): string | null {
  if (prompt === "help" || prompt === "/help") {
    return "Available commands: help, doctor, setup, config, /status, /resume, /session, /providers, /context, /memory, /compact, /approvals, /diff, /skills, /skills use <name>, /skills clear, /hooks, /init, /doctor, /review <goal>, /summary, /export [path], /reload-plugins, /debug-tool-call <command>, /mcp, /wechat, /wechat status, /wechat refresh, /plan <goal>, /orchestrate <goal>, /model <name>, /mode <permission-mode>, /approve [id], /deny [id], /read <path>, /glob <pattern>, /symbol <name>, /definition <name>, /references <name>, /bash <command>, /write <path> :: <content>, /append <path> :: <content>, /replace <path> :: <find> :: <replace>, /exit.";
  }

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
  private readonly skillRegistry = createSkillRegistry();
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
  private readonly slashRegistry = new SlashRegistry();

  constructor(private readonly options: QueryEngineOptions) {
    this.currentProvider = options.currentProvider;
    this.fallbackProvider = options.fallbackProvider;
    this.permissionMode = options.permissionMode;
    this.modelLabel = this.currentProvider?.model ?? "scaffold";
    this.permissions = new PermissionManager(this.permissionMode);
    this.pendingApprovals = loadPendingApprovals(options.approvalsDir);
    loadBuiltins(this.slashRegistry);
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

    if (this.pendingApprovals.length > 0) {
      const nextApproval = this.pendingApprovals[0];
      this.messages.push({
        id: createId("msg"),
        role: "assistant",
        text:
          this.pendingApprovals.length === 1
            ? `Recovered pending approval for ${nextApproval.toolName}. Run /approve or /deny.`
            : `Recovered ${this.pendingApprovals.length} pending approvals. Next: ${nextApproval.toolName} ${nextApproval.detail}. Run /approve or /deny.`,
        source: "local"
      });
    }

    this.lastEstimatedTokens = estimateMessageTokens(this.messages);
  }

  async *submitMessage(prompt: string, options?: QuerySubmitOptions): AsyncGenerator<EngineEvent> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
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

    yield { type: "phase", phase: "planning" };

    if (!trimmed.startsWith("/")) {
      const autoCompactResult = this.maybeAutoCompact();
      if (autoCompactResult) {
        yield { type: "phase", phase: "compacting" };
      }
    }

    yield { type: "phase", phase: "executing" };

    const messageId = createId("msg");
    let output = "";
    let assistantMessageSource: EngineMessageSource = "local";
    const approveTargetId = parseApprovalCommand(trimmed, "/approve");
    const denyTargetId = parseApprovalCommand(trimmed, "/deny");
    // P0 W2 · ADR-003：新注册表前置于旧 resolveBuiltinReply。
    //   - 命中且返回 reply → 走 builtinReply 分支（老下游无感知）
    //   - 命中 noop/passthrough 或未命中 → 继续走旧路径
    const slashDispatch = await this.slashRegistry.dispatch(trimmed, this);
    const slashReply = slashDispatch?.result.kind === "reply"
      ? slashDispatch.result.text
      : null;
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
        yield { type: "phase", phase: "completed" };
        return;
      }
      this.persistPendingApprovals();
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
        yield { type: "phase", phase: "completed" };
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
          yield { type: "phase", phase: "completed" };
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
        yield { type: "phase", phase: "completed" };
        return;
      }
      this.persistPendingApprovals();
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
          const activeApproval = this.pendingApprovals[0] ?? pendingApproval;
          output =
            this.pendingApprovals.length === 1
              ? `Approval required for ${inspection.toolName}: ${inspection.decision.reason}\nRun /approve or /deny.`
              : `Approval queued for ${inspection.toolName}: ${inspection.decision.reason}\nPending approvals: ${this.pendingApprovals.length}. Next up: ${activeApproval.toolName} ${activeApproval.detail}.\nRun /approve or /deny to process the queue.`;
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
      assistantMessageSource = "model";
      const providers = [this.currentProvider, this.fallbackProvider].filter(
        (provider, index, list): provider is ProviderStatus =>
          provider !== null && list.findIndex((item) => item?.type === provider.type) === index
      );
      let lastError: Error | null = null;
      let allowFallback = true;
      let reactiveCompactTriggered = false;

      while (true) {
        lastError = null;
        allowFallback = true;

        for (const provider of providers) {
          this.abortController = new AbortController();
          let providerProducedOutput = false;

          try {
            for await (const chunk of streamProviderResponse(provider, this.getProviderMessages(), {
              fetchImpl: this.options.fetchImpl,
              abortSignal: this.abortController.signal
            })) {
              providerProducedOutput = true;
              output += chunk;
              yield {
                type: "message-delta",
                messageId,
                delta: chunk
              };
            }

            lastError = null;
            break;
          } catch (error) {
            if ((error as Error).name === "AbortError") {
              this.interrupted = true;
              break;
            }

            lastError = error as Error;
            if (providerProducedOutput) {
              allowFallback = false;
              break;
            }

            output = "";
            continue;
          } finally {
            this.abortController = null;
          }
        }

        if (
          !this.interrupted &&
          !output &&
          lastError &&
          !reactiveCompactTriggered &&
          this.shouldReactiveCompact(lastError)
        ) {
          const reactiveCompactResult = this.performCompact(DEFAULT_COMPACT_KEEP_RECENT_MESSAGES);
          if (reactiveCompactResult) {
            reactiveCompactTriggered = true;
            this.reactiveCompactCount += 1;
            yield { type: "phase", phase: "compacting" };
            continue;
          }
        }

        break;
      }

      if (!this.interrupted && lastError) {
        if (!output) {
          output = this.buildProviderFailureMessage(lastError);
          assistantMessageSource = "local";
          yield {
            type: "message-delta",
            messageId,
            delta: output
          };
        } else if (!allowFallback) {
          const failureNote = `\n[stream interrupted: ${lastError.message}]`;
          output += failureNote;
          yield {
            type: "message-delta",
            messageId,
            delta: failureNote
          };
        }
      } else if (!this.interrupted && !output) {
        output = "Provider returned an empty response.";
        assistantMessageSource = "local";
        yield {
          type: "message-delta",
          messageId,
          delta: output
        };
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
      yield { type: "phase", phase: "halted" };
      return;
    }

    this.messages.push({
      id: messageId,
      role: "assistant",
      text: output,
      source: assistantMessageSource
    });
    this.notifyListeners();
    yield {
      type: "message-complete",
      messageId,
      text: output
    };
    yield { type: "phase", phase: "completed" };
  }

  private resolveBuiltinReply(prompt: string): string | null {
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
    if (matchesCommand(prompt, "/doctor")) {
      return runDoctor();
    }

    if (matchesCommand(prompt, "/summary")) {
      return this.buildSummaryReply();
    }

    if (matchesCommand(prompt, "/export")) {
      return this.handleExportCommand(prompt);
    }

    if (matchesCommand(prompt, "/reload-plugins")) {
      return this.buildReloadPluginsReply();
    }

    if (matchesCommand(prompt, "/debug-tool-call")) {
      return this.buildDebugToolCallReply(prompt);
    }

    if (matchesCommand(prompt, "/mcp")) {
      return this.handleMcpCommand(prompt);
    }

    if (matchesCommand(prompt, "/wechat")) {
      return this.handleWechatCommand(prompt);
    }

    if (matchesCommand(prompt, "/review")) {
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

      const execution = await executeOrchestrationPlan(plan, this.buildOrchestrationContext());
      const reflector = reflectOnExecution(plan.goals, execution, this.recentGapSignatures);
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
          planGoal: plan.userGoal
        }));

      return this.buildReviewReply(plan, execution, reflector);
    }

    if (matchesCommand(prompt, "/plan")) {
      const userGoal = prompt.replace("/plan", "").trim();
      if (!userGoal) {
        return "Usage: /plan <goal>";
      }

      const plan = buildOrchestrationPlan(userGoal, this.buildOrchestrationContext());
      return this.buildPlanReply(plan);
    }

    if (matchesCommand(prompt, "/orchestrate")) {
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

      const execution = await executeOrchestrationPlan(plan, this.buildOrchestrationContext());
      const reflector = reflectOnExecution(plan.goals, execution, this.recentGapSignatures);
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
          planGoal: plan.userGoal
        }));

      return this.buildOrchestrationReply(plan, execution, reflector);
    }

    return undefined;
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
          `${index + 1}. ${approval.id}  ${approval.toolName}  ${approval.detail}  ${approval.reason}`
      ),
      ...this.pendingOrchestrationApprovals.map(
        (approval, index) =>
          `${this.pendingApprovals.length + index + 1}. ${approval.id}  orchestration:${approval.operation}  ${approval.target}  ${approval.reason}`
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
    reflector: ReflectorResult
  ): string {
    return [
      "Orchestration",
      `goal: ${plan.userGoal}`,
      `intent: ${plan.intent.type}`,
      `strategy: ${plan.strategy.type}`,
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

  private handleModeCommand(prompt: string): string {
    const nextMode = prompt.replace("/mode", "").trim();

    if (!nextMode) {
      return `current mode: ${this.permissionMode}`;
    }

    if (!PERMISSION_MODES.includes(nextMode as PermissionMode)) {
      return `unknown mode: ${nextMode}\navailable: ${PERMISSION_MODES.join(", ")}`;
    }

    this.permissionMode = nextMode as PermissionMode;
    this.permissions.setMode(this.permissionMode);
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
      clearPendingApprovals(this.options.approvalsDir);
      return;
    }

    savePendingApprovals(this.options.approvalsDir, this.pendingApprovals as StoredPendingApproval[]);
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

  private getProviderMessages(): EngineMessage[] {
    const providerMessages = this.messages.filter((message) => {
      if (message.role === "user") {
        return message.source === "user";
      }

      if (message.role === "assistant") {
        return message.source === "model" || message.source === "summary";
      }

      return false;
    });

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
