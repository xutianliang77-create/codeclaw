/**
 * Auth state（B.2）· token + 连接状态
 */

import { create } from "zustand";

const STORAGE_KEY = "codeclaw_token";

interface AuthState {
  token: string;
  connected: boolean;
  setToken(t: string): void;
  setConnected(b: boolean): void;
  logout(): void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) ?? "" : "",
  connected: false,
  setToken(t) {
    if (typeof localStorage !== "undefined") {
      if (t) localStorage.setItem(STORAGE_KEY, t);
      else localStorage.removeItem(STORAGE_KEY);
    }
    set({ token: t });
  },
  setConnected(b) {
    set({ connected: b });
  },
  logout() {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
    set({ token: "", connected: false });
  },
}));
