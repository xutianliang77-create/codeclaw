/**
 * ToolCallCard · 单个 tool 调用折叠卡片（B.4）
 */

import { useState } from "react";
import type { ChatMessage } from "@/store/messages";

interface Props {
  tool: NonNullable<ChatMessage["tool"]>;
}

const STATUS_COLORS: Record<string, string> = {
  running: "border-accent bg-accent/5",
  completed: "border-ok bg-ok/5",
  blocked: "border-danger bg-danger/5",
  failed: "border-danger bg-danger/10",
  pending: "border-muted bg-muted/5",
};

const STATUS_ICONS: Record<string, string> = {
  running: "⏳",
  completed: "✓",
  blocked: "🛑",
  failed: "✗",
  pending: "·",
};

export default function ToolCallCard({ tool }: Props) {
  const [open, setOpen] = useState(false);
  const cls = STATUS_COLORS[tool.status] ?? "border-border";
  const icon = STATUS_ICONS[tool.status] ?? "·";
  return (
    <div className={`rounded border text-xs font-mono ${cls}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-2.5 py-1.5 flex items-center justify-between"
      >
        <span>
          {icon} <strong>{tool.name}</strong> · {tool.status}
        </span>
        <span className="text-muted">{open ? "▲" : "▼"}</span>
      </button>
      {open && tool.detail && (
        <pre className="px-2.5 pb-2 max-h-72 overflow-auto whitespace-pre-wrap">
          {tool.detail}
        </pre>
      )}
    </div>
  );
}
