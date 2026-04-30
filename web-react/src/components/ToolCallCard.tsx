/**
 * ToolCallCard · 单个 tool 调用折叠卡片（B.4）
 *
 * 特殊渲染：name === "chart_render" 且 detail 形如 "chart saved: <abs path>/<sess>/<id>.svg ..."
 * 时，提取 sessionId/chartId 走 /v1/web/charts/<sess>/<id>.svg 内嵌 <img>。
 */

import { useState } from "react";
import type { ChatMessage } from "@/store/messages";
import { useAuthStore } from "@/store/auth";

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

/**
 * 解析 chart_render 的 detail，提取 sessionId 和 chartId（文件名）。
 * detail 例：
 *   "chart saved: /home/u/.codeclaw/charts/session-X/chart_1700000000_abc123.svg (8KB; line; rows=10)"
 * 仅匹配落在 .codeclaw/charts/<safe>/<safe>.svg 形态的路径，否则返 null（防误渲染）。
 */
function parseChartPath(detail: string): { sessionId: string; chartFile: string } | null {
  const m = detail.match(/\.codeclaw\/charts\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+\.svg)/);
  if (!m) return null;
  return { sessionId: m[1], chartFile: m[2] };
}

export default function ToolCallCard({ tool }: Props) {
  const [open, setOpen] = useState(false);
  const cls = STATUS_COLORS[tool.status] ?? "border-border";
  const icon = STATUS_ICONS[tool.status] ?? "·";
  const token = useAuthStore((s) => s.token);

  // chart_render 完成 → 内嵌 SVG 预览
  const chartInfo =
    tool.name === "chart_render" && tool.status === "completed" && tool.detail
      ? parseChartPath(tool.detail)
      : null;

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
      {chartInfo && token && (
        <div className="px-2.5 pb-2 pt-1">
          <img
            src={`/v1/web/charts/${encodeURIComponent(chartInfo.sessionId)}/${encodeURIComponent(chartInfo.chartFile)}?token=${encodeURIComponent(token)}`}
            alt="chart"
            className="max-w-full rounded border border-border bg-white"
          />
        </div>
      )}
      {open && tool.detail && (
        <pre className="px-2.5 pb-2 max-h-72 overflow-auto whitespace-pre-wrap">
          {tool.detail}
        </pre>
      )}
    </div>
  );
}
