import { useAuthStore } from "@/store/auth";
import ThemeToggle from "./ThemeToggle";

export default function Header() {
  const { logout } = useAuthStore();
  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-border">
      <h1 className="text-lg font-bold">
        CodeClaw <span className="text-xs text-muted font-normal ml-1">web · react</span>
      </h1>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted hidden sm:inline">⌘K 命令搜</span>
        <ThemeToggle />
        <button
          onClick={logout}
          className="px-3 py-1 text-sm text-muted hover:text-fg border border-border rounded"
        >
          登出
        </button>
      </div>
    </header>
  );
}
