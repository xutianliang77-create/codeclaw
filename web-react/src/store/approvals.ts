/**
 * Pending approval state（B.5）
 *
 * Per-session 单 active approval（multi-pending 时只展示首个；与后端 API 一致）
 */

import { create } from "zustand";

export interface ApprovalView {
  id: string;
  toolName: string;
  detail: string;
  reason: string;
  queuePosition: number;
  totalPending: number;
}

interface ApprovalsState {
  bySession: Map<string, ApprovalView | null>;
  set(sessionId: string, approval: ApprovalView | null): void;
  clear(sessionId: string): void;
  get(sessionId: string): ApprovalView | null;
}

export const useApprovalsStore = create<ApprovalsState>((set, get) => ({
  bySession: new Map(),
  set(sessionId, approval) {
    set((s) => {
      const next = new Map(s.bySession);
      next.set(sessionId, approval);
      return { bySession: next };
    });
  },
  clear(sessionId) {
    set((s) => {
      const next = new Map(s.bySession);
      next.delete(sessionId);
      return { bySession: next };
    });
  },
  get(sessionId) {
    return get().bySession.get(sessionId) ?? null;
  },
}));
