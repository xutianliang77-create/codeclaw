/**
 * Per-session message buffer（B.4）
 *
 * - Map<sessionId, Message[]>，切 session 不刷彼此
 * - 流式：append delta 到当前 streaming bubble；message-complete 时关闭
 * - tool-call：单独类型；前端折叠展示
 */

import { create } from "zustand";

export type MessageRole = "user" | "assistant" | "system" | "error" | "tool";

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  text: string;
  /** assistant 流式中（msg-delta 进来一直 true，message-complete 后 false） */
  streaming?: boolean;
  /** tool 类型时附带 */
  tool?: { name: string; status: "running" | "completed" | "blocked" | "failed" | "pending"; detail?: string };
  ts: number;
}

interface MessagesState {
  bySession: Map<string, ChatMessage[]>;
  appendUser(sessionId: string, text: string): void;
  startAssistant(sessionId: string, messageId: string): void;
  appendDelta(sessionId: string, messageId: string, delta: string): void;
  completeAssistant(sessionId: string, messageId: string, finalText: string): void;
  appendTool(sessionId: string, name: string, status: ChatMessage["tool"] extends infer T ? (T extends { status: infer S } ? S : never) : never, detail?: string): void;
  appendError(sessionId: string, text: string): void;
  clear(sessionId: string): void;
  get(sessionId: string): ChatMessage[];
}

export const useMessagesStore = create<MessagesState>((set, get) => ({
  bySession: new Map(),
  appendUser(sessionId, text) {
    set((s) => {
      const next = new Map(s.bySession);
      const arr = [...(next.get(sessionId) ?? [])];
      arr.push({ id: crypto.randomUUID(), sessionId, role: "user", text, ts: Date.now() });
      next.set(sessionId, arr);
      return { bySession: next };
    });
  },
  startAssistant(sessionId, messageId) {
    set((s) => {
      const next = new Map(s.bySession);
      const arr = [...(next.get(sessionId) ?? [])];
      arr.push({
        id: messageId,
        sessionId,
        role: "assistant",
        text: "",
        streaming: true,
        ts: Date.now(),
      });
      next.set(sessionId, arr);
      return { bySession: next };
    });
  },
  appendDelta(sessionId, messageId, delta) {
    set((s) => {
      const next = new Map(s.bySession);
      const arr = next.get(sessionId);
      if (!arr) return s;
      const idx = arr.findIndex((m) => m.id === messageId);
      if (idx < 0) return s;
      const updated = [...arr];
      updated[idx] = { ...updated[idx], text: updated[idx].text + delta };
      next.set(sessionId, updated);
      return { bySession: next };
    });
  },
  completeAssistant(sessionId, messageId, finalText) {
    set((s) => {
      const next = new Map(s.bySession);
      const arr = next.get(sessionId);
      if (!arr) return s;
      const idx = arr.findIndex((m) => m.id === messageId);
      const updated = [...arr];
      if (idx >= 0) {
        updated[idx] = { ...updated[idx], text: finalText, streaming: false };
      } else {
        updated.push({
          id: messageId,
          sessionId,
          role: "assistant",
          text: finalText,
          ts: Date.now(),
        });
      }
      next.set(sessionId, updated);
      return { bySession: next };
    });
  },
  appendTool(sessionId, name, status, detail) {
    set((s) => {
      const next = new Map(s.bySession);
      const arr = [...(next.get(sessionId) ?? [])];
      arr.push({
        id: crypto.randomUUID(),
        sessionId,
        role: "tool",
        text: "",
        tool: { name, status, detail: detail ?? "" },
        ts: Date.now(),
      });
      next.set(sessionId, arr);
      return { bySession: next };
    });
  },
  appendError(sessionId, text) {
    set((s) => {
      const next = new Map(s.bySession);
      const arr = [...(next.get(sessionId) ?? [])];
      arr.push({ id: crypto.randomUUID(), sessionId, role: "error", text, ts: Date.now() });
      next.set(sessionId, arr);
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
    return get().bySession.get(sessionId) ?? [];
  },
}));
