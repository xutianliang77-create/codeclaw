/**
 * Sessions state（B.2）· 当前 active session + 全部 list
 */

import { create } from "zustand";
import type { SessionMeta } from "@/api/endpoints";

interface SessionsState {
  list: SessionMeta[];
  activeId: string | null;
  setList(next: SessionMeta[]): void;
  setActive(id: string | null): void;
  upsert(s: SessionMeta): void;
}

export const useSessionsStore = create<SessionsState>((set) => ({
  list: [],
  activeId: null,
  setList(next) {
    set({ list: next });
  },
  setActive(id) {
    set({ activeId: id });
  },
  upsert(s) {
    set((state) => {
      const idx = state.list.findIndex((x) => x.sessionId === s.sessionId);
      const list = [...state.list];
      if (idx >= 0) list[idx] = s;
      else list.unshift(s);
      return { list };
    });
  },
}));
