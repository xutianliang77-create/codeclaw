/**
 * 主题切换按钮（B.11）· auto → light → dark 循环
 */
import { useThemeStore, type Theme } from "@/store/theme";

const ICONS: Record<Theme, string> = {
  auto: "◐",
  light: "☀",
  dark: "☾",
};

const NEXT: Record<Theme, Theme> = {
  auto: "light",
  light: "dark",
  dark: "auto",
};

export default function ThemeToggle() {
  const { theme, resolved, setTheme } = useThemeStore();
  const label = theme === "auto" ? `auto (${resolved})` : theme;
  return (
    <button
      onClick={() => setTheme(NEXT[theme])}
      className="px-2.5 py-1 text-sm border border-border rounded text-muted hover:text-fg"
      title={`切换主题 · 当前：${label}`}
      aria-label={`切换主题，当前 ${label}`}
    >
      {ICONS[theme]} <span className="ml-1 text-xs">{label}</span>
    </button>
  );
}
