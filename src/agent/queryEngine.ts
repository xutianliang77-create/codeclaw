import { clearPendingApprovals, loadPendingApprovals, savePendingApprovals } from "../approvals/store";
import type { StoredPendingApproval } from "../approvals/store";
import type { PermissionMode } from "../lib/config";
import { PermissionManager } from "../permissions/manager";
import { ProviderRequestError, streamProviderResponse } from "../provider/client";
import type { ProviderStatus } from "../provider/types";
import { detectLocalTool, inspectLocalTool, isHandledLocalToolResult, runLocalTool } from "../tools/local";
import type { LocalToolName } from "../tools/local";
import type {
  EngineEvent,
  EngineMessage,
  EngineMessageSource,
  PendingApprovalView,
  QueryEngine,
  QueryEngineOptions
} from "./types";

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildBuiltinReply(prompt: string): string | null {
  if (prompt === "help" || prompt === "/help") {
    return "Available commands: help, doctor, setup, config, /status, /resume, /session, /providers, /context, /memory, /compact, /approvals, /diff, /skills, /hooks, /init, /model <name>, /mode <permission-mode>, /approve [id], /deny [id], /read <path>, /glob <pattern>, /symbol <name>, /definition <name>, /references <name>, /bash <command>, /write <path> :: <content>, /append <path> :: <content>, /replace <path> :: <find> :: <replace>, /exit.";
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

type PendingApproval = {
  id: string;
  prompt: string;
  toolName: LocalToolName;
  detail: string;
  reason: string;
  createdAt: string;
  sessionId?: string;
};

class LocalQueryEngine implements QueryEngine {
  private readonly sessionId = createId("session");
  private readonly messages: EngineMessage[];
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

  constructor(private readonly options: QueryEngineOptions) {
    this.currentProvider = options.currentProvider;
    this.fallbackProvider = options.fallbackProvider;
    this.permissionMode = options.permissionMode;
    this.modelLabel = this.currentProvider?.model ?? "scaffold";
    this.permissions = new PermissionManager(this.permissionMode);
    this.pendingApprovals = loadPendingApprovals(options.approvalsDir);
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

  async *submitMessage(prompt: string): AsyncGenerator<EngineEvent> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }

    this.interrupted = false;

    this.messages.push({
      id: createId("msg"),
      role: "user",
      text: trimmed,
      source: trimmed.startsWith("/") ? "command" : "user"
    });
    this.lastEstimatedTokens = estimateMessageTokens(this.messages);

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
    const builtinReply = this.resolveBuiltinReply(trimmed);
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
        yield { type: "phase", phase: "completed" };
        return;
      }
      this.persistPendingApprovals();
      yield {
        type: "approval-cleared",
        approvalId: approval.id
      };
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
    } else if (localToolName) {
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
    } else if (!this.options.currentProvider) {
      output = 'No available provider. Run `codeclaw setup` or `codeclaw config` to configure one.';
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
    yield {
      type: "message-complete",
      messageId,
      text: output
    };
    yield { type: "phase", phase: "completed" };
  }

  private resolveBuiltinReply(prompt: string): string | null {
    if (parseApprovalCommand(prompt, "/approve") !== undefined) {
      return this.pendingApprovals.length > 0 ? null : "No pending approval.";
    }

    if (parseApprovalCommand(prompt, "/deny") !== undefined) {
      return this.pendingApprovals.length > 0 ? null : "No pending approval.";
    }

    if (matchesCommand(prompt, "/status")) {
      return this.buildStatusReply();
    }

    if (matchesCommand(prompt, "/resume")) {
      return this.buildResumeReply();
    }

    if (matchesCommand(prompt, "/session")) {
      return this.buildSessionReply();
    }

    if (matchesCommand(prompt, "/providers")) {
      return this.buildProvidersReply();
    }

    if (matchesCommand(prompt, "/approvals")) {
      return this.buildApprovalsReply();
    }

    if (matchesCommand(prompt, "/context")) {
      return this.buildContextReply();
    }

    if (matchesCommand(prompt, "/memory")) {
      return this.buildMemoryReply();
    }

    if (matchesCommand(prompt, "/diff")) {
      return this.buildDiffReply();
    }

    if (matchesCommand(prompt, "/skills")) {
      return this.buildSkillsReply();
    }

    if (matchesCommand(prompt, "/hooks")) {
      return this.buildHooksReply();
    }

    if (matchesCommand(prompt, "/init")) {
      return this.buildInitReply();
    }

    if (matchesCommand(prompt, "/compact")) {
      return this.handleCompactCommand(prompt);
    }

    if (matchesCommand(prompt, "/model")) {
      return this.handleModelCommand(prompt);
    }

    if (matchesCommand(prompt, "/mode")) {
      return this.handleModeCommand(prompt);
    }

    return buildBuiltinReply(prompt);
  }

  private buildStatusReply(): string {
    const activeApproval = this.pendingApprovals[0];
    const pending = activeApproval
      ? `${activeApproval.toolName} pending approval (${this.pendingApprovals.length} queued)`
      : "none";

    return [
      `session: ${this.sessionId}`,
      `provider: ${this.currentProvider?.displayName ?? "not-configured"}`,
      `fallback: ${this.fallbackProvider?.displayName ?? "none"}`,
      `model: ${this.modelLabel}`,
      `mode: ${this.permissionMode}`,
      `workspace: ${this.options.workspace}`,
      `messages: ${this.messages.length}`,
      `estimated-tokens: ${this.lastEstimatedTokens}`,
      `reactive-compacts: ${this.reactiveCompactCount}`,
      `pending-approval: ${pending}`
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
    if (this.pendingApprovals.length === 0) {
      return "No pending approvals.";
    }

    return [
      `pending approvals: ${this.pendingApprovals.length}`,
      ...this.pendingApprovals.map(
        (approval, index) =>
          `${index + 1}. ${approval.id}  ${approval.toolName}  ${approval.detail}  ${approval.reason}`
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

  private buildSkillsReply(): string {
    return [
      "skills: none configured inside the Phase 1 scaffold",
      "Note: platform-level Codex skills may still be available outside the in-app agent loop."
    ].join("\n");
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
      "3. Start with `/read`, `/glob`, `/symbol`, `/definition`, `/references`, `/bash`, or a normal prompt."
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
    return this.messages.filter((message) => {
      if (message.role === "user") {
        return message.source === "user";
      }

      if (message.role === "assistant") {
        return message.source === "model" || message.source === "summary";
      }

      return false;
    });
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
  } {
    return {
      modelLabel: this.modelLabel,
      permissionMode: this.permissionMode,
      providerLabel: this.currentProvider?.displayName ?? "not-configured",
      fallbackProviderLabel: this.fallbackProvider?.displayName ?? "none"
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
}

export function createQueryEngine(options: QueryEngineOptions): QueryEngine {
  return new LocalQueryEngine({
    ...options
  });
}
