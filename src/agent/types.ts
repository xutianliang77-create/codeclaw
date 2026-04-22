import type { PermissionMode } from "../lib/config";
import type { ProviderStatus } from "../provider/types";

export type EngineMessageRole = "user" | "assistant" | "system";
export type EngineMessageSource = "user" | "command" | "model" | "local" | "summary";

export type EnginePhase = "idle" | "planning" | "compacting" | "executing" | "completed" | "halted";

export interface EngineMessage {
  id: string;
  role: EngineMessageRole;
  text: string;
  source?: EngineMessageSource;
}

export interface PendingApprovalView {
  id: string;
  toolName: string;
  detail: string;
  reason: string;
  queuePosition: number;
  totalPending: number;
}

export interface QueryEngineOptions {
  currentProvider: ProviderStatus | null;
  fallbackProvider: ProviderStatus | null;
  permissionMode: PermissionMode;
  workspace: string;
  autoCompactThreshold?: number;
  approvalsDir?: string;
  fetchImpl?: typeof fetch;
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
  submitMessage(prompt: string): AsyncGenerator<EngineEvent>;
  interrupt(): void;
  getMessages(): EngineMessage[];
  getPendingApproval(): PendingApprovalView | null;
  getSessionId(): string;
  setModel(model: string): void;
  getRuntimeState(): {
    modelLabel: string;
    permissionMode: PermissionMode;
    providerLabel: string;
    fallbackProviderLabel: string;
  };
  getReadFileState(): Record<string, never>;
}
