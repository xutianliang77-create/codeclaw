/**
 * Workspace: 顶部 tabs + 左侧 sessions sidebar + 主面板 + 状态栏
 */

import { useState } from "react";
import Header from "./Header";
import SessionsList from "./SessionsList";
import StatusLine from "./StatusLine";
import ChatPane from "./ChatPane";
import CommandPalette from "./CommandPalette";
import SubagentTree from "./SubagentTree";
import RagPanel from "./panels/RagPanel";
import GraphPanel from "./panels/GraphPanel";
import McpPanel from "./panels/McpPanel";
import HooksPanel from "./panels/HooksPanel";
import { useSessionsStore } from "@/store/sessions";

type TabId = "chat" | "rag" | "graph" | "mcp" | "hooks" | "subagents";

const TABS: { id: TabId; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "rag", label: "RAG" },
  { id: "graph", label: "Graph" },
  { id: "mcp", label: "MCP" },
  { id: "hooks", label: "Hooks" },
  { id: "subagents", label: "Subagents" },
];

interface Props {
  onError(msg: string | null): void;
}

export default function Workspace({ onError }: Props) {
  const [tab, setTab] = useState<TabId>("chat");
  const activeId = useSessionsStore((s) => s.activeId);

  return (
    <div className="h-full flex flex-col">
      <CommandPalette
        onPick={(entry) => {
          // 选中后切到 chat tab，便于看到 composer
          setTab("chat");
          console.info("[palette] picked", entry.name);
        }}
      />
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
          {tab === "subagents" && (
            <div className="p-4 overflow-y-auto">
              <SubagentTree sessionId={activeId} />
            </div>
          )}
        </main>
      </div>
      <StatusLine />
    </div>
  );
}
