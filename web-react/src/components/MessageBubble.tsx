/**
 * MessageBubble · 渲染单条消息（B.4）
 *
 * - user：右对齐
 * - assistant + streaming：闪烁光标 + 流式 markdown
 * - tool：折叠卡片
 * - system / error：灰条 / 红条
 */

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import type { ChatMessage } from "@/store/messages";
import ToolCallCard from "./ToolCallCard";

interface Props {
  msg: ChatMessage;
}

function BubbleInner({ msg }: Props) {
  if (msg.role === "tool" && msg.tool) {
    return <ToolCallCard tool={msg.tool} />;
  }
  if (msg.role === "error") {
    return (
      <div className="rounded px-3 py-2 text-sm bg-danger/10 text-danger border border-danger/30">
        {msg.text}
      </div>
    );
  }
  if (msg.role === "system") {
    return (
      <div className="text-xs text-muted px-2 py-1 italic">{msg.text}</div>
    );
  }
  if (msg.role === "user") {
    return (
      <div className="self-end max-w-[80%] rounded px-3 py-2 text-sm bg-accent/10 whitespace-pre-wrap">
        {msg.text}
      </div>
    );
  }
  // assistant
  const cursor = msg.streaming ? <span className="animate-pulse text-muted">▋</span> : null;
  return (
    <div className="max-w-[90%] rounded px-3 py-2 text-sm bg-bg/60 border border-border markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      >
        {msg.text || ""}
      </ReactMarkdown>
      {cursor}
    </div>
  );
}

export default memo(BubbleInner, (prev, next) => {
  // 流式中跨更新比较 text；非流式只看 id 是否变
  if (prev.msg.streaming || next.msg.streaming) {
    return prev.msg.id === next.msg.id && prev.msg.text === next.msg.text;
  }
  return prev.msg.id === next.msg.id;
});
