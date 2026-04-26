/**
 * Per-session subagent records（B.8 SSE 推流接通）
 *
 * - 双源：HTTP polling（兜底）+ SSE 实时事件
 * - SSE 来 subagent-start → upsert 一条 status=running
 * - SSE 来 subagent-end → 更新对应记录的 status / duration / error / preview
 */

import { create } from "zustand";

export interface SubagentRow {
  id: string;
  role: string;
  prompt: string;
  status: "running" | "completed" | "failed" | "timeout";
  startedAt: number;
  finishedAt?: number;
  toolCallCount?: number;
  durationMs?: number;
  error?: string;
  resultPreview?: string;
}

interface State {
  bySession: Map<string, SubagentRow[]>;
  setAll(sessionId: string, list: SubagentRow[]): void;
  start(sessionId: string, row: SubagentRow): void;
  end(sessionId: string, id: string, patch: Partial<SubagentRow>): void;
  get(sessionId: string): SubagentRow[];
}

export const useSubagentsStore = create<State>((set, get) => ({
  bySession: new Map(),
  setAll(sessionId, list) {
    set((s) => {
      const next = new Map(s.bySession);
      next.set(sessionId, list);
      return { bySession: next };
    });
  },
  start(sessionId, row) {
    set((s) => {
      const next = new Map(s.bySession);
      const arr = next.get(sessionId) ?? [];
      // 避免 polling 与 SSE 重复 push 同 id；id 已存在则更新
      const exists = arr.findIndex((r) => r.id === row.id);
      const updated = [...arr];
      if (exists >= 0) updated[exists] = { ...updated[exists], ...row };
      else updated.unshift(row);
      next.set(sessionId, updated);
      return { bySession: next };
    });
  },
  end(sessionId, id, patch) {
    set((s) => {
      const next = new Map(s.bySession);
      const arr = next.get(sessionId);
      if (!arr) return s;
      const idx = arr.findIndex((r) => r.id === id);
      if (idx < 0) return s;
      const updated = [...arr];
      updated[idx] = { ...updated[idx], ...patch };
      next.set(sessionId, updated);
      return { bySession: next };
    });
  },
  get(sessionId) {
    return get().bySession.get(sessionId) ?? [];
  },
}));
