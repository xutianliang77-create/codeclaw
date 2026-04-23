import type { EngineMessage } from "../../agent/types";
import type { WechatCardRenderInput } from "./types";

const WECHAT_MARKDOWN_SOFT_LIMIT = 1200;

function clip(text: string, maxLength = 600): string {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function findLatestAssistantMessage(messages: EngineMessage[]): string {
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  return latestAssistant?.text.trim() || "暂无回复。";
}

function findLatestUserMessage(messages: EngineMessage[]): string {
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  return latestUser?.text.trim() || "暂无输入。";
}

function trimCardToWechatLimit(sections: string[]): string {
  const joined = sections.join("\n");
  if (joined.length <= WECHAT_MARKDOWN_SOFT_LIMIT) {
    return joined;
  }

  return `${joined.slice(0, WECHAT_MARKDOWN_SOFT_LIMIT - 19)}\n\n[内容过长，已截断]`;
}

export function buildWechatMarkdownCard(input: WechatCardRenderInput): string {
  const latestInput = clip(findLatestUserMessage(input.snapshot.messages), 180);
  const latestReply = clip(findLatestAssistantMessage(input.snapshot.messages), 700);
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
        `- detail: ${approval.detail}`,
        `- reason: ${approval.reason}`,
        `- queue: ${approval.queuePosition}/${approval.totalPending}`,
        "- 回复 `/approve` 或 `/deny`"
      ]
    : orchestrationApproval
      ? [
          "## 待审批",
          `- orchestration: ${orchestrationApproval.operation}`,
          `- target: ${orchestrationApproval.target}`,
          `- reason: ${orchestrationApproval.reason}`,
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
