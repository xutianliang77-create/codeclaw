import { FormEvent, useEffect, useState } from "react";
import {
  graphBuild,
  graphQuery,
  graphStatus,
  type GraphQueryType,
  type GraphStatus,
} from "@/api/endpoints";

interface Props {
  onError(msg: string | null): void;
}

export default function GraphPanel({ onError }: Props) {
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [type, setType] = useState<GraphQueryType>("callers");
  const [arg, setArg] = useState("");
  const [arg2, setArg2] = useState("");
  const [result, setResult] = useState("");
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
    setResult("构建中...");
    try {
      const r = await graphBuild();
      setResult(r.summary);
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
    setResult("查询中...");
    try {
      const r = await graphQuery(type, arg.trim(), arg2.trim() || undefined);
      setResult(JSON.stringify(r.result, null, 2));
    } catch (err) {
      onError(`graph query 失败：${(err as Error).message}`);
      setResult("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 space-y-3 overflow-y-auto">
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={refreshStatus} className="btn-secondary">刷新</button>
        <button onClick={handleBuild} disabled={busy} className="btn-secondary">重建图</button>
        {status && (
          <span className="text-xs text-muted font-mono">
            symbols={status.symbols} imports={status.imports} calls={status.calls}
          </span>
        )}
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
        <button type="submit" disabled={busy} className="btn-primary">查询</button>
      </form>

      <pre className="bg-bg border border-border rounded p-3 text-xs font-mono max-h-[60vh] overflow-auto whitespace-pre-wrap">
        {result || "（运行查询查看结果；阶段 B 后续接 d3 force-directed）"}
      </pre>
    </div>
  );
}
