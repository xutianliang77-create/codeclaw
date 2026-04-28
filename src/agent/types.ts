import type { PermissionMode } from "../lib/config";
import type { ProviderStatus } from "../provider/types";

export type EngineMessageRole = "user" | "assistant" | "system" | "tool";
export type EngineMessageSource = "user" | "command" | "model" | "local" | "summary";

export type EnginePhase = "idle" | "planning" | "compacting" | "executing" | "completed" | "halted";

export interface EngineImageAttachment {
  kind: "image";
  localPath: string;
  mimeType?: string;
  fileName?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  sourceUrl?: string;
}

/** M2-05：非 image 附件（.pdf / .txt / .csv / .md / 等）；走 extractAttachmentText 提文本 */
export interface EngineFileAttachment {
  kind: "file";
  localPath: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** M2-05：附件联合类型 */
export type EngineAttachment = EngineImageAttachment | EngineFileAttachment;

/** assistant 一轮调用的 tool_use 记录（M1-B/C） */
export interface EngineToolCallRef {
  id: string;
  name: string;
  args: unknown;
}

export interface EngineMessage {
  id: string;
  role: EngineMessageRole;
  text: string;
  source?: EngineMessageSource;
  attachments?: EngineAttachment[];
  /** role: "tool" 时填；指向 assistant 上一轮的 toolCalls[].id */
  toolCallId?: string;
  /** role: "tool" 时填；冗余存名便于查询 */
  toolName?: string;
  /** role: "assistant" 含 tool_use 时填；这一轮 LLM 调用了哪些工具 */
  toolCalls?: EngineToolCallRef[];
  /** role: "assistant" 时可填：reasoning 模型的思考过程（OpenAI delta.reasoning_content / reasoning）；
   *  与 text（最终答案）分离存储，避免在 provider replay / autoCompact / token budget 中污染 */
  reasoning?: string;
}

export interface PendingApprovalView {
  id: string;
  toolName: string;
  detail: string;
  reason: string;
  queuePosition: number;
  totalPending: number;
}

export interface PendingOrchestrationApprovalView {
  id: string;
  operation: "write" | "append" | "replace";
  target: string;
  reason: string;
  queuePosition: number;
  totalPending: number;
}

export interface ChannelSessionSnapshot {
  sessionId: string;
  messages: EngineMessage[];
  pendingApproval: PendingApprovalView | null;
  pendingOrchestrationApproval: PendingOrchestrationApprovalView | null;
  runtime: {
    modelLabel: string;
    permissionMode: PermissionMode;
    providerLabel: string;
    fallbackProviderLabel: string;
    activeSkillName: string | null;
    visionSupport: "supported" | "unsupported" | "unknown";
    visionReason: string;
  };
}

export interface WechatLoginStateView {
  phase: "idle" | "waiting" | "scanned" | "confirmed" | "expired" | "error";
  qrcode?: string;
  qrcodeImageContent?: string;
  tokenFile: string;
  baseUrl: string;
  message: string;
  ilinkBotId?: string;
  ilinkUserId?: string;
}

export interface QueryEngineOptions {
  currentProvider: ProviderStatus | null;
  fallbackProvider: ProviderStatus | null;
  permissionMode: PermissionMode;
  workspace: string;
  autoCompactThreshold?: number;
  approvalsDir?: string;
  /** 审计链 db 路径；不传走 ~/.codeclaw/audit.db。设为 null 显式禁用 audit。 */
  auditDbPath?: string | null;
  /** L2 Session Memory 用的 data.db 路径；不传走 ~/.codeclaw/data.db。null 禁用 */
  dataDbPath?: string | null;
  /** L2 Memory 召回需要 (channel, userId) 隔离；不传时不启用 L2 */
  channel?: import("../channels/channelAdapter").ChannelType;
  userId?: string;
  /** /forget 清理时要删的会话文件根；不传走 ~/.codeclaw/sessions */
  sessionsDir?: string;
  /** #86：成本预算（USD / token 双阈值）；不传走 env CODECLAW_BUDGET_*；都没则不检查 */
  budget?: import("../provider/budget").BudgetConfig;
  fetchImpl?: typeof fetch;
  /**
   * M3-01：可选注入 McpManager（已 start + initialized 完成）。
   * 给入时 queryEngine 在 constructor 内自动 bridge tools 进 ToolRegistry，
   * /mcp 命令也优先走 manager；不传则降级到 in-process service.ts（workspace-mcp）。
   */
  mcpManager?: import("../mcp/manager").McpManager;
  /**
   * M3-04：lifecycle hooks 配置（已 parse 后的 settings）。
   * 不传则按"无 hook"处理。5 个事件 PreToolUse/PostToolUse/UserPromptSubmit/Stop/SessionStart。
   */
  settings?: import("../hooks/settings").CodeclawSettings;
  wechat?: {
    tokenFile?: string;
    baseUrl?: string;
    attachCurrentSession?(): void;
    loginManager?: {
      ensureStarted(): Promise<WechatLoginStateView>;
      restart?(): Promise<WechatLoginStateView>;
      refreshStatus(): Promise<WechatLoginStateView>;
      getState(): WechatLoginStateView;
    };
    /** v0.7.2：显式启动消息 worker（同进程 long-poll）。/wechat worker slash 用。 */
    startWorker?: () => Promise<void>;
  };
}

export interface QuerySubmitOptions {
  channelSpecific?: Record<string, unknown>;
}

export type EngineEvent =
  | {
      type: "phase";
      phase: EnginePhase;
    }
  | {
      type: "approval-request";
      approvalId: string;
      toolName: string;
      detail: string;
      reason: string;
      queuePosition: number;
      totalPending: number;
    }
  | {
      type: "approval-cleared";
      approvalId: string;
    }
  | {
      type: "tool-start";
      toolName: string;
      detail: string;
    }
  | {
      type: "tool-end";
      toolName: string;
      status: "completed" | "blocked" | "failed" | "pending";
    }
  | {
      type: "message-start";
      messageId: string;
      role: "assistant";
    }
  | {
      type: "message-delta";
      messageId: string;
      delta: string;
    }
  | {
      type: "message-complete";
      messageId: string;
      text: string;
    }
  | {
      // B.8 阶段 B：subagent 真实推送（替代 3s 轮询）
      type: "subagent-start";
      id: string;
      role: string;
      prompt: string;
      startedAt: number;
    }
  | {
      type: "subagent-end";
      id: string;
      status: "completed" | "failed" | "timeout";
      toolCallCount: number;
      durationMs: number;
      error?: string;
      resultPreview?: string;
    };

export interface QueryEngine {
  submitMessage(prompt: string, options?: QuerySubmitOptions): AsyncGenerator<EngineEvent>;
  interrupt(): void;
  subscribe(listener: () => void): () => void;
  getMessages(): EngineMessage[];
  getPendingApproval(): PendingApprovalView | null;
  getChannelSnapshot(): ChannelSessionSnapshot;
  getSessionId(): string;
  setModel(model: string): void;
  getRuntimeState(): {
    modelLabel: string;
    permissionMode: PermissionMode;
    providerLabel: string;
    fallbackProviderLabel: string;
    activeSkillName: string | null;
    visionSupport: "supported" | "unsupported" | "unknown";
    visionReason: string;
  };
  getReadFileState(): Record<string, never>;
  /** 给 /cost / /status 等读 FSM 当前快照（W2-05） */
  getFsmSnapshot?(): import("../fsm").FsmSnapshot;
  /** 给测试 / 调试访问审计链（W3-01；可能 null：未开启或打开失败） */
  getAuditLog?(): import("../storage/auditLog").AuditLog | null;
  /** D1：热重载 hooks 配置（SIGHUP 触发） */
  setHooksConfig?(next: import("../hooks/settings").HookSettings): void;
}
