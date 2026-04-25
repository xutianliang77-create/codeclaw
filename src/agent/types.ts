import type { PermissionMode } from "../lib/config";
import type { ProviderStatus } from "../provider/types";

export type EngineMessageRole = "user" | "assistant" | "system";
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

export interface EngineMessage {
  id: string;
  role: EngineMessageRole;
  text: string;
  source?: EngineMessageSource;
  attachments?: EngineImageAttachment[];
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
}
