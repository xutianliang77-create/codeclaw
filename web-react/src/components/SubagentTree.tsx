/**
 * SubagentTree · 子 agent 工作树（B.8 前端骨架）
 *
 * 当前后端 /v1/web/sessions/<id>/subagents 返 placeholder，
 * 待 queryEngine instrumentation 接通后切走 SSE `subagent-*` 子事件。
 */

import { useEffect, useState } from "react";
import { getSubagents } from "@/api/endpoints";
import { useSubagentsStore, type SubagentRow } from "@/store/subagents";

type SubagentNode = SubagentRow & { children?: SubagentNode[] };

// P5.1：模块级单例，selector ?? EMPTY 避免每次 render 返回新数组触发 React #185 死循环
const EMPTY_SUBAGENTS: SubagentRow[] = [];

const STATUS_COLORS: Record<string, string> = {
  running: "border-accent",
  completed: "border-ok",
  failed: "border-danger",
  timeout: "border-danger",
};

interface Props {
  sessionId: string | null;
}

export default function SubagentTree({ sessionId }: Props) {
  // 主源：SSE 推送写入的 store；polling 兜底（首次拉历史 + SSE 断线自愈）
  const items = useSubagentsStore((s) =>
    sessionId ? s.bySession.get(sessionId) ?? EMPTY_SUBAGENTS : EMPTY_SUBAGENTS
  );
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!sessionId) {
      setNote(null);
      setError(null);
      return;
    }
    async function refresh() {
      try {
        const r = await getSubagents(sessionId!);
        if (cancelled) return;
        // polling 不 overwrite，仅当 store 当前为空时用作 hydrate
        const snapshot = useSubagentsStore.getState().get(sessionId!);
        if (snapshot.length === 0 && r.subagents.length > 0) {
          useSubagentsStore.getState().setAll(sessionId!, r.subagents as SubagentRow[]);
        }
        setNote(r.note ?? null);
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }
    refresh();
    const id = setInterval(refresh, 8000); // SSE 实时；polling 仅兜底，间隔放宽到 8s
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId]);

  if (!sessionId) {
    return <div className="text-sm text-muted">需要先选 session。</div>;
  }
  if (error) {
    return <div className="text-sm text-danger">读取失败：{error}</div>;
  }
  if (items.length === 0) {
    return (
      <div className="text-sm text-muted space-y-1">
        <p>当前 session 无 subagent 调用记录。</p>
        {note && <p className="text-xs italic">{note}</p>}
        <p className="text-xs">
          后端推流改造在 阶段 B 后续接通；当前 placeholder 端点保证前端可正常 render。
        </p>
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((it, i) => (
        <SubagentRow key={i} node={it} />
      ))}
    </ul>
  );
}

function SubagentRow({ node }: { node: SubagentNode }) {
  const cls = STATUS_COLORS[node.status ?? ""] ?? "border-border";
  return (
    <li className={`border rounded p-2.5 ${cls}`}>
      <div className="text-sm flex items-center gap-2">
        <strong>{node.role ?? "?"}</strong>
        <span className="text-xs text-muted">·</span>
        <span className="text-xs">{node.status ?? "?"}</span>
        {node.id && <span className="text-xs text-muted ml-auto font-mono">{node.id}</span>}
      </div>
      {node.prompt && (
        <pre className="text-xs text-muted mt-1 font-mono whitespace-pre-wrap line-clamp-2">{node.prompt}</pre>
      )}
      <div className="text-xs text-muted mt-1 flex gap-3">
        <span>tools={node.toolCallCount ?? 0}</span>
        {node.durationMs !== undefined && <span>{node.durationMs}ms</span>}
        {node.startedAt && (
          <span>started {new Date(node.startedAt).toLocaleTimeString()}</span>
        )}
      </div>
      {node.error && (
        <div className="text-xs text-danger mt-1 font-mono">error: {node.error}</div>
      )}
      {node.resultPreview && (
        <pre className="text-xs mt-1 bg-bg p-1.5 rounded whitespace-pre-wrap max-h-24 overflow-auto">
          {node.resultPreview}
        </pre>
      )}
      {node.children && node.children.length > 0 && (
        <ul className="mt-2 ml-4 border-l border-border pl-3 space-y-2">
          {node.children.map((c, i) => (
            <SubagentRow key={i} node={c} />
          ))}
        </ul>
      )}
    </li>
  );
}
