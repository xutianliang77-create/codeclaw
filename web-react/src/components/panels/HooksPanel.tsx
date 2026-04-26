import { useEffect, useState } from "react";
import { getHooks, reloadHooks } from "@/api/endpoints";

interface Props {
  onError(msg: string | null): void;
}

export default function HooksPanel({ onError }: Props) {
  const [events, setEvents] = useState<Record<string, unknown>>({});
  const [summary, setSummary] = useState("...");

  async function refresh() {
    try {
      const r = await getHooks();
      setEvents(r.events ?? {});
      setSummary(`${Object.keys(r.events ?? {}).length} 类事件配置`);
    } catch (err) {
      onError(`hooks 读取失败：${(err as Error).message}`);
      setSummary("读取失败");
    }
  }

  async function handleReload() {
    setSummary("重载中...");
    try {
      const r = await reloadHooks();
      setEvents(r.events ?? {});
      setSummary(`重载完成 · ${Object.keys(r.events ?? {}).length} 类事件`);
    } catch (err) {
      setSummary(`重载失败：${(err as Error).message}`);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasContent = Object.keys(events).length > 0;
  return (
    <div className="p-4 space-y-3 overflow-y-auto">
      <div className="flex items-center gap-2">
        <button onClick={handleReload} className="btn-primary">重载 settings.json</button>
        <button onClick={refresh} className="btn-secondary">刷新</button>
        <span className="text-xs text-muted">{summary}</span>
      </div>
      {!hasContent && (
        <p className="text-sm text-muted">（settings.json 中未配置任何 hook）</p>
      )}
      <pre className="bg-bg border border-border rounded p-3 text-xs font-mono max-h-[60vh] overflow-auto whitespace-pre-wrap">
        {hasContent ? JSON.stringify(events, null, 2) : ""}
      </pre>
    </div>
  );
}
