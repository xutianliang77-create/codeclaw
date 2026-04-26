/**
 * ApprovalCard · 待审批工具调用提示（B.5）
 *
 * 后端 SSE `approval-request` → store；点 Approve / Deny 走 sendMessage
 * 发 `/approve <id>` / `/deny <id>`，后端 dispatch 到 queryEngine。
 */

import { useState } from "react";
import { sendMessage } from "@/api/endpoints";
import { useApprovalsStore, type ApprovalView } from "@/store/approvals";

interface Props {
  sessionId: string;
  approval: ApprovalView;
  onError(msg: string | null): void;
}

export default function ApprovalCard({ sessionId, approval, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const clear = useApprovalsStore((s) => s.clear);

  async function decide(verb: "approve" | "deny") {
    setBusy(true);
    try {
      await sendMessage(sessionId, `/${verb} ${approval.id}`);
      // SSE 应推 approval-cleared 自动清；这里乐观清避免按钮卡住
      clear(sessionId);
    } catch (err) {
      onError(`${verb} 失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-accent rounded p-3 my-2 bg-accent/5">
      <div className="flex items-center justify-between mb-1.5">
        <strong className="text-sm">⚠ 待审批：{approval.toolName}</strong>
        <span className="text-xs text-muted">
          {approval.queuePosition}/{approval.totalPending}
        </span>
      </div>
      {approval.reason && (
        <div className="text-xs text-muted mb-1.5">{approval.reason}</div>
      )}
      {approval.detail && (
        <pre className="text-xs font-mono bg-bg p-2 rounded max-h-40 overflow-auto whitespace-pre-wrap mb-2">
          {approval.detail}
        </pre>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => decide("approve")}
          disabled={busy}
          className="px-3 py-1 bg-ok text-white rounded text-sm disabled:opacity-50"
        >
          ✓ Approve
        </button>
        <button
          onClick={() => decide("deny")}
          disabled={busy}
          className="px-3 py-1 bg-danger text-white rounded text-sm disabled:opacity-50"
        >
          ✗ Deny
        </button>
        <span className="text-xs text-muted self-center ml-auto">
          快捷：直接在输入框打 /approve 或 /deny
        </span>
      </div>
    </div>
  );
}
