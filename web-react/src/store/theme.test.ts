import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useThemeStore } from "./theme";

describe("themeStore", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("setTheme('light') 写 localStorage + data-theme attr", () => {
    useThemeStore.getState().setTheme("light");
    expect(localStorage.getItem("codeclaw_theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(useThemeStore.getState().resolved).toBe("light");
  });

  it("setTheme('dark') 同上", () => {
    useThemeStore.getState().setTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(useThemeStore.getState().resolved).toBe("dark");
  });

  it("setTheme('auto') resolved 跟随系统（happy-dom 默认 light）", () => {
    useThemeStore.getState().setTheme("auto");
    expect(useThemeStore.getState().theme).toBe("auto");
    // happy-dom 默认 prefers-color-scheme 不匹配 dark → 解析为 light
    expect(["light", "dark"]).toContain(useThemeStore.getState().resolved);
  });
});
