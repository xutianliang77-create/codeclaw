/**
 * 首次连接：输入 token → 调 /v1/web/sessions 验证 + 拿到当前 user
 */

import { FormEvent, useState } from "react";
import { useAuthStore } from "@/store/auth";
import { listSessions } from "@/api/endpoints";

interface Props {
  onError(msg: string | null): void;
}

export default function ConnectScreen({ onError }: Props) {
  const { token, setToken, setConnected } = useAuthStore();
  const [draft, setDraft] = useState(token);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft) {
      onError("请输入 CODECLAW_WEB_TOKEN");
      return;
    }
    setBusy(true);
    setToken(draft.trim());
    try {
      await listSessions();
      setConnected(true);
      onError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onError(`连接失败：${msg}`);
      setConnected(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex items-center justify-center">
      <form onSubmit={submit} className="w-96 space-y-4 p-6 border border-border rounded-lg bg-bg">
        <h1 className="text-xl font-bold">CodeClaw · Web (React)</h1>
        <p className="text-sm text-muted">输入 CODECLAW_WEB_TOKEN 与 codeclaw web 服务端对齐</p>
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="CODECLAW_WEB_TOKEN"
          className="w-full px-3 py-2 bg-bg border border-border rounded font-mono text-sm"
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full px-4 py-2 bg-accent text-white rounded font-medium disabled:opacity-50"
        >
          {busy ? "连接中..." : "连接"}
        </button>
        <p className="text-xs text-muted text-center">
          token 仅存浏览器 localStorage，不发到第三方
        </p>
      </form>
    </div>
  );
}
