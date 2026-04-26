/**
 * Chat 面板（B.4 占位实现）
 *
 * 阶段 B.4 完整版要求：虚拟滚动 + markdown + tool-call 折叠 + diff 视图。
 * 本文件先提供最小可用 stub：列消息 + 发送 + SSE 监听。
 * 等做到 B.4 step 时再换 react-virtual + react-markdown。
 */

import { FormEvent, useEffect, useRef, useState } from "react";
import { useSessionsStore } from "@/store/sessions";
import { sendMessage } from "@/api/endpoints";
import { openEventSource } from "@/api/client";

interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "error";
  text: string;
}

interface Props {
  onError(msg: string | null): void;
}

export default function ChatPane({ onError }: Props) {
  const { activeId } = useSessionsStore();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const sseRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!activeId) return;
    setMessages([]);
    sseRef.current?.close();
    const es = openEventSource(`/v1/web/stream?sessionId=${encodeURIComponent(activeId)}`);
    sseRef.current = es;
    es.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data);
        if (data?.type === "message-complete") {
          setMessages((prev) => [
            ...prev,
            { id: data.messageId ?? crypto.randomUUID(), role: "assistant", text: data.text },
          ]);
        }
      } catch {
        // 忽略 ping 心跳等非 JSON 行
      }
    });
    es.addEventListener("error", () => {
      // 401（最常见）或网络断；阶段 B 后续做带 token 的 SSE 适配
      onError("SSE 连接失败（EventSource 不支持 Authorization 头，等 server ?token 适配）");
    });
    return () => {
      es.close();
      sseRef.current = null;
    };
  }, [activeId, onError]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!activeId || !input.trim() || busy) return;
    const text = input.trim();
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", text }]);
    setInput("");
    setBusy(true);
    try {
      await sendMessage(activeId, text);
    } catch (err) {
      onError(`发送失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!activeId) {
    return (
      <div className="p-6 text-muted text-sm">请在左侧选择或新建一个 session。</div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {messages.map((m) => (
          <div
            key={m.id}
            className={
              "rounded px-3 py-2 text-sm whitespace-pre-wrap " +
              (m.role === "user"
                ? "bg-accent/10 self-end max-w-[80%]"
                : m.role === "error"
                  ? "bg-danger/10 text-danger"
                  : "bg-bg/60 max-w-[90%]")
            }
          >
            <span className="text-xs text-muted block mb-0.5">{m.role}</span>
            {m.text}
          </div>
        ))}
        {messages.length === 0 && (
          <div className="text-muted text-sm">输入消息开始（B.4 加 markdown / 流式）。</div>
        )}
      </div>
      <form onSubmit={submit} className="border-t border-border p-3 flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          placeholder="输入消息（Enter 发送 · Shift+Enter 换行）"
          className="flex-1 px-3 py-2 bg-bg border border-border rounded resize-none text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(e as unknown as FormEvent);
            }
          }}
        />
        <button
          type="submit"
          disabled={busy}
          className="px-4 py-2 bg-accent text-white rounded disabled:opacity-50"
        >
          {busy ? "..." : "发送"}
        </button>
      </form>
    </div>
  );
}
