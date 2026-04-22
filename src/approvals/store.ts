import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LocalToolName } from "../tools/local";

export interface StoredPendingApproval {
  id: string;
  prompt: string;
  toolName: LocalToolName;
  detail: string;
  reason: string;
  createdAt: string;
  sessionId?: string;
}

function getApprovalFile(approvalsDir: string): string {
  return path.join(approvalsDir, "pending-approval.json");
}

function createApprovalId(): string {
  return `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeApproval(input: Omit<StoredPendingApproval, "id" | "createdAt"> & Partial<StoredPendingApproval>): StoredPendingApproval {
  return {
    id: input.id ?? createApprovalId(),
    prompt: input.prompt,
    toolName: input.toolName,
    detail: input.detail,
    reason: input.reason,
    createdAt: input.createdAt ?? new Date().toISOString(),
    sessionId: input.sessionId
  };
}

export function loadPendingApprovals(approvalsDir?: string): StoredPendingApproval[] {
  if (!approvalsDir) {
    return [];
  }

  const approvalFile = getApprovalFile(approvalsDir);
  if (!existsSync(approvalFile)) {
    return [];
  }

  const parsed = JSON.parse(readFileSync(approvalFile, "utf8")) as
    | StoredPendingApproval
    | StoredPendingApproval[]
    | null;

  if (!parsed) {
    return [];
  }

  if (Array.isArray(parsed)) {
    return parsed.map((approval) => normalizeApproval(approval));
  }

  return [normalizeApproval(parsed)];
}

export function savePendingApprovals(
  approvalsDir: string | undefined,
  approvals: StoredPendingApproval[]
): void {
  if (!approvalsDir) {
    return;
  }

  if (approvals.length === 0) {
    rmSync(getApprovalFile(approvalsDir), { force: true });
    return;
  }

  mkdirSync(approvalsDir, { recursive: true });
  writeFileSync(getApprovalFile(approvalsDir), JSON.stringify(approvals, null, 2), "utf8");
}

export function clearPendingApprovals(approvalsDir?: string): void {
  if (!approvalsDir) {
    return;
  }

  rmSync(getApprovalFile(approvalsDir), { force: true });
}
