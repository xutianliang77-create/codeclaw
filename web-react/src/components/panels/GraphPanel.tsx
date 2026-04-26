import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  graphBuild,
  graphQuery,
  graphStatus,
  type GraphQueryType,
  type GraphStatus,
} from "@/api/endpoints";
import GraphForce, { type ForceLink, type ForceNode } from "./GraphForce";

interface Props {
  onError(msg: string | null): void;
}

interface CallerRow {
  callerPath: string;
  callerLine: number;
  calleeName: string;
  calleePath: string | null;
}
interface ImportRow {
  srcPath: string;
  dstPath: string | null;
  module: string;
}
interface SymbolRow {
  symbolId: string;
  relPath: string;
  name: string;
  kind: string;
  line: number;
  exported: boolean;
}
type QueryShape =
  | { callers: CallerRow[] }
  | { callees: CallerRow[] }
  | { dependents: ImportRow[] }
  | { dependencies: ImportRow[] }
  | { symbols: SymbolRow[] };

/** 把后端 QueryResult 转成 force graph 的 nodes/links */
function toForceGraph(
  type: GraphQueryType,
  arg: string,
  data: unknown
): { nodes: ForceNode[]; links: ForceLink[] } {
  const nodes = new Map<string, ForceNode>();
  const links: ForceLink[] = [];

  function addNode(id: string, group: ForceNode["group"]): void {
    if (!nodes.has(id)) nodes.set(id, { id, group });
  }

  if (!data || typeof data !== "object") return { nodes: [], links: [] };

  if (type === "callers" || type === "callees") {
    const rows = ((data as { callers?: CallerRow[]; callees?: CallerRow[] }).callers ??
      (data as { callees?: CallerRow[] }).callees ??
      []) as CallerRow[];
    addNode(arg, "symbol");
    for (const r of rows) {
      addNode(r.callerPath, "file");
      const calleeId = r.calleePath ?? r.calleeName;
      addNode(calleeId, r.calleePath ? "file" : "external");
      links.push({ source: r.callerPath, target: calleeId, kind: "calls" });
    }
  } else if (type === "dependents" || type === "dependencies") {
    const rows = ((data as { dependents?: ImportRow[]; dependencies?: ImportRow[] })
      .dependents ??
      (data as { dependencies?: ImportRow[] }).dependencies ??
      []) as ImportRow[];
    addNode(arg, "file");
    for (const r of rows) {
      addNode(r.srcPath, "file");
      const dst = r.dstPath ?? r.module;
      addNode(dst, r.dstPath ? "file" : "external");
      links.push({ source: r.srcPath, target: dst, kind: "imports" });
    }
  } else if (type === "symbol") {
    const rows = ((data as { symbols?: SymbolRow[] }).symbols ?? []) as SymbolRow[];
    addNode(arg, rows.length === 1 ? "file" : "symbol");
    for (const r of rows) {
      addNode(r.relPath, "file");
      addNode(r.name, "symbol");
      links.push({ source: r.relPath, target: r.name, kind: "declares" });
    }
  }
  return { nodes: [...nodes.values()], links };
}

export default function GraphPanel({ onError }: Props) {
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [type, setType] = useState<GraphQueryType>("callers");
  const [arg, setArg] = useState("");
  const [arg2, setArg2] = useState("");
  const [result, setResult] = useState<QueryShape | null>(null);
  const [view, setView] = useState<"force" | "json">("force");
  const [busy, setBusy] = useState(false);

  async function refreshStatus() {
    try {
      setStatus(await graphStatus());
    } catch (err) {
      onError(`graph status 失败：${(err as Error).message}`);
    }
  }

  useEffect(() => {
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleBuild() {
    setBusy(true);
    try {
      const r = await graphBuild();
      setResult(null);
      console.info("[graph build]", r.summary);
      refreshStatus();
    } catch (err) {
      onError(`graph build 失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleQuery(e: FormEvent) {
    e.preventDefault();
    if (!arg.trim()) return;
    setBusy(true);
    try {
      const r = await graphQuery(type, arg.trim(), arg2.trim() || undefined);
      setResult(r.result as QueryShape);
    } catch (err) {
      onError(`graph query 失败：${(err as Error).message}`);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  const force = useMemo(
    () => (result ? toForceGraph(type, arg, result) : { nodes: [], links: [] }),
    [result, type, arg]
  );

  return (
    <div className="p-4 space-y-3 overflow-y-auto">
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={refreshStatus} className="btn-secondary">
          刷新
        </button>
        <button onClick={handleBuild} disabled={busy} className="btn-secondary">
          重建图
        </button>
        {status && (
          <span className="text-xs text-muted font-mono">
            symbols={status.symbols} imports={status.imports} calls={status.calls}
          </span>
        )}
        <span className="ml-auto flex gap-1">
          <button
            onClick={() => setView("force")}
            className={view === "force" ? "btn-primary" : "btn-secondary"}
          >
            Force
          </button>
          <button
            onClick={() => setView("json")}
            className={view === "json" ? "btn-primary" : "btn-secondary"}
          >
            JSON
          </button>
        </span>
      </div>

      <form onSubmit={handleQuery} className="grid grid-cols-[160px_1fr_1fr_auto] gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as GraphQueryType)}
          className="px-2 py-1.5 bg-bg border border-border rounded text-sm"
        >
          <option value="callers">callers</option>
          <option value="callees">callees</option>
          <option value="dependents">dependents</option>
          <option value="dependencies">dependencies</option>
          <option value="symbol">symbol</option>
        </select>
        <input
          value={arg}
          onChange={(e) => setArg(e.target.value)}
          placeholder="symbol / 文件路径"
          className="px-3 py-1.5 bg-bg border border-border rounded text-sm"
        />
        <input
          value={arg2}
          onChange={(e) => setArg2(e.target.value)}
          placeholder="可选：限定 callee 路径"
          className="px-3 py-1.5 bg-bg border border-border rounded text-sm"
        />
        <button type="submit" disabled={busy} className="btn-primary">
          查询
        </button>
      </form>

      {!result && (
        <div className="text-sm text-muted">运行查询查看结果（Force 或 JSON 视图）。</div>
      )}

      {result && view === "force" && (
        <GraphForce
          nodes={force.nodes}
          links={force.links}
          onNodeClick={(n) => console.info("[graph click]", n.id)}
          onNodeDoubleClick={(n) => {
            // 双击 file → callers；symbol → callers by name
            setArg(n.id);
            setType(n.group === "file" ? "dependents" : "callers");
          }}
        />
      )}

      {result && view === "json" && (
        <pre className="bg-bg border border-border rounded p-3 text-xs font-mono max-h-[60vh] overflow-auto whitespace-pre-wrap">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
