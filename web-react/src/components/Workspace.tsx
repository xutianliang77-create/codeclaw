/**
 * Workspace: 顶部 tabs + 左侧 sessions sidebar + 主面板 + 状态栏
 */

import { useState } from "react";
import Header from "./Header";
import SessionsList from "./SessionsList";
import StatusLine from "./StatusLine";
import ChatPane from "./ChatPane";
import RagPanel from "./panels/RagPanel";
import GraphPanel from "./panels/GraphPanel";
import McpPanel from "./panels/McpPanel";
import HooksPanel from "./panels/HooksPanel";

type TabId = "chat" | "rag" | "graph" | "mcp" | "hooks";

const TABS: { id: TabId; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "rag", label: "RAG" },
  { id: "graph", label: "Graph" },
  { id: "mcp", label: "MCP" },
  { id: "hooks", label: "Hooks" },
];

interface Props {
  onError(msg: string | null): void;
}

export default function Workspace({ onError }: Props) {
  const [tab, setTab] = useState<TabId>("chat");

  return (
    <div className="h-full flex flex-col">
      <Header />
      <nav className="flex gap-1 px-4 pt-2 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              "px-4 py-1.5 text-sm rounded-t border border-transparent border-b-0 -mb-px " +
              (tab === t.id
                ? "border-border bg-bg text-fg"
                : "text-muted hover:text-fg")
            }
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 grid grid-cols-[220px_1fr] gap-3 p-3 min-h-0">
        <SessionsList onError={onError} />
        <main className="border border-border rounded-lg bg-bg/40 overflow-hidden flex flex-col min-h-0">
          {tab === "chat" && <ChatPane onError={onError} />}
          {tab === "rag" && <RagPanel onError={onError} />}
          {tab === "graph" && <GraphPanel onError={onError} />}
          {tab === "mcp" && <McpPanel onError={onError} />}
          {tab === "hooks" && <HooksPanel onError={onError} />}
        </main>
      </div>
      <StatusLine />
    </div>
  );
}
