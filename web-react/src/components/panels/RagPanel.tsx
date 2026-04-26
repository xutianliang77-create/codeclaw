import { FormEvent, useEffect, useState } from "react";
import { ragEmbed, ragIndex, ragSearch, ragStatus, type RagHit, type RagStatus as RagStatusT } from "@/api/endpoints";

interface Props {
  onError(msg: string | null): void;
}

export default function RagPanel({ onError }: Props) {
  const [status, setStatus] = useState<RagStatusT | null>(null);
  const [statusText, setStatusText] = useState("...");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RagHit[]>([]);
  const [mode, setMode] = useState<"hybrid" | "bm25" | null>(null);
  const [busy, setBusy] = useState(false);

  async function refreshStatus() {
    try {
      const r = await ragStatus();
      setStatus(r);
      setStatusText(
        `chunks=${r.chunkCount} embedded=${r.embeddedCount}/${r.chunkCount} last=${
          r.lastIndexedAt ? new Date(r.lastIndexedAt).toLocaleString() : "never"
        }`
      );
    } catch (err) {
      onError(`RAG status 失败：${(err as Error).message}`);
      setStatusText("读取失败");
    }
  }

  useEffect(() => {
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleIndex() {
    setBusy(true);
    setStatusText("索引中...");
    try {
      const r = await ragIndex();
      setStatusText(r.summary);
      refreshStatus();
    } catch (err) {
      onError(`索引失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleEmbed() {
    setBusy(true);
    setStatusText("embedding 中...");
    try {
      const r = await ragEmbed();
      setStatusText(
        `embedded-now=${r.embeddedNow} total=${r.embeddedTotal} remaining=${r.remaining} ${r.durationMs}ms`
      );
      refreshStatus();
    } catch (err) {
      onError(`embed 失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    try {
      const r = await ragSearch(query.trim(), 8);
      setHits(r.hits);
      setMode(r.mode);
    } catch (err) {
      onError(`搜索失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 space-y-3 overflow-y-auto">
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={refreshStatus} className="btn-secondary">刷新</button>
        <button onClick={handleIndex} disabled={busy} className="btn-secondary">索引 workspace</button>
        <button onClick={handleEmbed} disabled={busy} className="btn-secondary">补 embedding</button>
        <span className="text-xs text-muted font-mono">{statusText}</span>
      </div>

      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="关键字 / 自然语言搜代码..."
          className="flex-1 px-3 py-1.5 bg-bg border border-border rounded text-sm"
        />
        <button type="submit" disabled={busy} className="btn-primary">搜索</button>
      </form>

      {mode && <div className="text-xs text-muted">mode={mode}</div>}

      <ol className="space-y-2 list-none">
        {hits.map((h, i) => {
          const score = h.rrfScore != null ? `rrf=${h.rrfScore.toFixed(4)}` : `bm25=${(h.score ?? 0).toFixed(2)}`;
          return (
            <li key={i} className="border border-border rounded p-2.5">
              <div className="text-xs text-muted font-mono mb-1">
                [{i + 1}] {h.relPath}:{h.lineStart}-{h.lineEnd} {score} {h.source ?? ""}
              </div>
              <pre className="bg-bg p-2 rounded text-xs font-mono max-h-64 overflow-auto whitespace-pre-wrap">
                {(h.content ?? "").slice(0, 1200)}
              </pre>
            </li>
          );
        })}
        {hits.length === 0 && status && (
          <li className="text-sm text-muted">未搜索 / 无结果</li>
        )}
      </ol>
    </div>
  );
}
