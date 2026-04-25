import type { EngineMessage } from "../../agent/types";
import { sanitizeForDisplay } from "../../lib/displaySafe";
import type { WechatCardRenderInput } from "./types";

const WECHAT_MARKDOWN_SOFT_LIMIT = 1200;

function clip(text: string, maxLength = 600): string {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function findLatestTurn(messages: EngineMessage[]): {
  latestInput: string;
  latestReply: string;
} {
  const latestAssistantIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find((entry) => entry.message.role === "assistant")?.index;

  if (latestAssistantIndex === undefined) {
    const latestUser = [...messages].reverse().find((message) => message.role === "user");
    return {
      latestInput: latestUser?.text.trim() || "暂无输入。",
      latestReply: "暂无回复。"
    };
  }

  const latestAssistant = messages[latestAssistantIndex];
  const latestUser = [...messages.slice(0, latestAssistantIndex)]
    .reverse()
    .find((message) => message.role === "user");

  return {
    latestInput: latestUser?.text.trim() || "暂无输入。",
    latestReply: latestAssistant?.text.trim() || "暂无回复。"
  };
}

function trimCardToWechatLimit(sections: string[]): string {
  const joined = sections.join("\n");
  if (joined.length <= WECHAT_MARKDOWN_SOFT_LIMIT) {
    return joined;
  }

  return `${joined.slice(0, WECHAT_MARKDOWN_SOFT_LIMIT - 19)}\n\n[内容过长，已截断]`;
}

export function buildWechatMarkdownCard(input: WechatCardRenderInput): string {
  const latestTurn = findLatestTurn(input.snapshot.messages);
  const latestInput = clip(input.latestInputOverride ?? latestTurn.latestInput, 180);
  const latestReply = clip(latestTurn.latestReply, 700);
  const approval = input.snapshot.pendingApproval;
  const orchestrationApproval = input.snapshot.pendingOrchestrationApproval;

  const heading =
    input.variant === "approval-notify"
      ? "# CodeClaw 审批通知"
      : input.variant === "resume"
        ? "# CodeClaw 会话恢复"
        : input.variant === "session-sync"
          ? "# CodeClaw 会话同步"
        : "# CodeClaw 微信 Bot";

  const approvalLines = approval
    ? [
        "## 待审批",
        `- tool: ${approval.toolName}`,
        `- detail: ${sanitizeForDisplay(approval.detail)}`,
        `- reason: ${sanitizeForDisplay(approval.reason)}`,
        `- queue: ${approval.queuePosition}/${approval.totalPending}`,
        "- 回复 `/approve` 或 `/deny`"
      ]
    : orchestrationApproval
      ? [
          "## 待审批",
          `- orchestration: ${orchestrationApproval.operation}`,
          `- target: ${sanitizeForDisplay(orchestrationApproval.target)}`,
          `- reason: ${sanitizeForDisplay(orchestrationApproval.reason)}`,
          `- queue: ${orchestrationApproval.queuePosition}/${orchestrationApproval.totalPending}`,
          "- 回复 `/approve` 或 `/deny`"
        ]
      : [];

  return trimCardToWechatLimit([
    heading,
    "",
    "## 最新输入",
    latestInput,
    "",
    "## 最新回复",
    latestReply,
    ...(approvalLines.length > 0 ? ["", ...approvalLines] : []),
    ...(input.variant === "resume" && approvalLines.length === 0
      ? ["", "## 恢复状态", "当前没有待审批项，可继续发送消息。"]
      : [])
  ]);
}
