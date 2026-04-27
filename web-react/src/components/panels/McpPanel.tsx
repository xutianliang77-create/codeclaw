import { FormEvent, useEffect, useState } from "react";
import {
  callMcpTool,
  listMcpServers,
  listMcpTools,
  type McpServerSnapshot,
  type McpToolDescriptor,
} from "@/api/endpoints";

interface Props {
  onError(msg: string | null): void;
}

export default function McpPanel({ onError }: Props) {
  const [servers, setServers] = useState<McpServerSnapshot[]>([]);
  const [serverFilter, setServerFilter] = useState<string>("");
  const [tools, setTools] = useState<McpToolDescriptor[]>([]);
  const [test, setTest] = useState({ server: "", tool: "", args: "{}" });
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  async function refresh() {
    try {
      const r = await listMcpServers();
      setServers(r.servers);
      setUnavailable(false);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 503) {
        setUnavailable(true);
      } else {
        onError(`MCP servers 失败：${e.message}`);
      }
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function browseTools(name: string) {
    setBusy(true);
    setServerFilter(name);
    try {
      const r = await listMcpTools(name);
      setTools(r.tools);
      setTest((t) => ({ ...t, server: name }));
    } catch (err) {
      onError(`列 tools 失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function runCall(e: FormEvent) {
    e.preventDefault();
    let args: unknown;
    try {
      args = test.args.trim() ? JSON.parse(test.args) : {};
    } catch {
      onError("args 不是合法 JSON");
      return;
    }
    setBusy(true);
    try {
      const r = await callMcpTool(test.server, test.tool, args);
      setResult(JSON.stringify(r, null, 2));
    } catch (err) {
      setResult((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (unavailable) {
    return (
      <div className="p-6 text-sm text-muted">
        MCP manager 未在 web 通道注入。重启 codeclaw web 时由 cli.tsx 传入；当前 build
        如果 mcpManager 缺失，可能是 mcp.json 没配置 servers。
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3 overflow-y-auto">
      <div className="flex items-center gap-2">
        <button onClick={refresh} className="btn-secondary">刷新</button>
        <span className="text-xs text-muted">{servers.length} server(s)</span>
      </div>

      <ul className="space-y-2">
        {servers.map((s) => (
          <li
            key={s.name}
            className={
              "border rounded p-2.5 " +
              (s.status === "ready"
                ? "border-ok"
                : s.status === "failed"
                  ? "border-danger"
                  : "border-border")
            }
          >
            <div className="text-sm">
              <strong>{s.name}</strong> · {s.status} · tools={s.toolCount} ·
              restarts={s.restartCount}
            </div>
            {s.lastError && (
              <div className="text-xs text-danger font-mono mt-1">{s.lastError}</div>
            )}
            <button onClick={() => browseTools(s.name)} className="btn-tertiary mt-2">
              浏览 tools
            </button>
          </li>
        ))}
        {servers.length === 0 && (
          <li className="text-sm text-muted">未配置 MCP servers</li>
        )}
      </ul>

      {tools.length > 0 && (
        <div>
          <h3 className="text-xs uppercase text-muted mt-4 mb-1">
            {serverFilter} tools ({tools.length})
          </h3>
          <ul className="space-y-1">
            {tools.map((t) => (
              <li key={`${t.server}-${t.name}`} className="text-xs font-mono">
                <button
                  onClick={() => setTest((s) => ({ ...s, tool: t.name }))}
                  className="text-accent hover:underline"
                >
                  {t.name}
                </button>
                {t.description && <span className="text-muted ml-2">{t.description}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3 className="text-xs uppercase text-muted mt-4">Test call · 测试调用</h3>
      <form onSubmit={runCall} className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <input
            value={test.server}
            onChange={(e) => setTest({ ...test, server: e.target.value })}
            placeholder="server"
            className="px-2 py-1.5 bg-bg border border-border rounded text-sm"
          />
          <input
            value={test.tool}
            onChange={(e) => setTest({ ...test, tool: e.target.value })}
            placeholder="tool"
            className="px-2 py-1.5 bg-bg border border-border rounded text-sm"
          />
        </div>
        <textarea
          value={test.args}
          onChange={(e) => setTest({ ...test, args: e.target.value })}
          rows={3}
          className="w-full px-2 py-1.5 bg-bg border border-border rounded text-sm font-mono"
          placeholder='{"path":"/data/x.txt"}'
        />
        <button type="submit" disabled={busy} className="btn-primary">调用</button>
      </form>
      <pre className="bg-bg border border-border rounded p-3 text-xs font-mono max-h-[40vh] overflow-auto whitespace-pre-wrap">
        {result || "（结果会展示在这里）"}
      </pre>
    </div>
  );
}
