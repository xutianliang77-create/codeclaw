/**
 * 主题切换（B.11）· light / dark / auto
 *
 * - localStorage 持久化用户选择
 * - auto 跟随 prefers-color-scheme（默认）
 * - 应用方式：root html 上加 data-theme="light|dark"，CSS variables 由 :root[data-theme=...] 覆盖
 */

import { create } from "zustand";

export type Theme = "auto" | "light" | "dark";

const KEY = "codeclaw_theme";

interface ThemeState {
  theme: Theme;
  resolved: "light" | "dark";
  setTheme(t: Theme): void;
  /** 重新解析 auto 时跟随的系统值 */
  syncResolved(): void;
}

function readStored(): Theme {
  if (typeof localStorage === "undefined") return "auto";
  const v = localStorage.getItem(KEY);
  if (v === "light" || v === "dark" || v === "auto") return v;
  return "auto";
}

function detectSystem(): "light" | "dark" {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolve(theme: Theme): "light" | "dark" {
  if (theme === "auto") return detectSystem();
  return theme;
}

function applyToDom(resolved: "light" | "dark"): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const theme = readStored();
  const resolved = resolve(theme);
  applyToDom(resolved);
  return {
    theme,
    resolved,
    setTheme(t) {
      if (typeof localStorage !== "undefined") localStorage.setItem(KEY, t);
      const r = resolve(t);
      applyToDom(r);
      set({ theme: t, resolved: r });
    },
    syncResolved() {
      const cur = get().theme;
      if (cur !== "auto") return;
      const r = detectSystem();
      applyToDom(r);
      set({ resolved: r });
    },
  };
});

/** 监听系统主题变化（auto 时自动跟随） */
export function bindSystemThemeWatcher(): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => useThemeStore.getState().syncResolved();
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
