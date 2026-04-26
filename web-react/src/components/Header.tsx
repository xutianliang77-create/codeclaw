import { useAuthStore } from "@/store/auth";

export default function Header() {
  const { logout } = useAuthStore();
  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-border">
      <h1 className="text-lg font-bold">
        CodeClaw <span className="text-xs text-muted font-normal ml-1">web · react</span>
      </h1>
      <button
        onClick={logout}
        className="px-3 py-1 text-sm text-muted hover:text-fg border border-border rounded"
      >
        登出
      </button>
    </header>
  );
}
