import { useEffect } from "react";
import { useSessionsStore } from "@/store/sessions";
import { createSession, listSessions } from "@/api/endpoints";

interface Props {
  onError(msg: string | null): void;
}

export default function SessionsList({ onError }: Props) {
  const { list, activeId, setList, setActive } = useSessionsStore();

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const r = await listSessions();
        if (cancelled) return;
        setList(r.sessions);
        if (!activeId && r.sessions[0]) setActive(r.sessions[0].sessionId);
      } catch (err) {
        if (!cancelled) onError(`session 列表读取失败：${(err as Error).message}`);
      }
    }
    refresh();
    const id = setInterval(refresh, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeId, setList, setActive, onError]);

  async function handleNew() {
    try {
      const meta = await createSession();
      useSessionsStore.getState().upsert(meta);
      setActive(meta.sessionId);
    } catch (err) {
      onError(`新建 session 失败：${(err as Error).message}`);
    }
  }

  return (
    <aside className="flex flex-col gap-2 min-h-0">
      <button
        onClick={handleNew}
        className="px-3 py-1.5 text-sm border border-border rounded text-left bg-bg/60 hover:bg-bg"
      >
        + 新会话
      </button>
      <ul className="overflow-y-auto flex flex-col gap-1.5 min-h-0">
        {list.map((s) => {
          const active = s.sessionId === activeId;
          return (
            <li key={s.sessionId}>
              <button
                onClick={() => setActive(s.sessionId)}
                className={
                  "w-full text-left px-2 py-1.5 text-sm border rounded " +
                  (active
                    ? "border-accent bg-accent/10"
                    : "border-border bg-bg hover:bg-bg/80")
                }
              >
                <div className="font-mono text-xs">
                  {s.sessionId.replace(/^web-/, "").slice(0, 12)}
                </div>
                <div className="text-xs text-muted">
                  {new Date(s.lastSeenAt ?? s.createdAt).toLocaleTimeString()}
                </div>
              </button>
            </li>
          );
        })}
        {list.length === 0 && (
          <li className="text-xs text-muted px-2">无会话；点 + 新会话</li>
        )}
      </ul>
    </aside>
  );
}
