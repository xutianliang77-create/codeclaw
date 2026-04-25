/**
 * Web Channel Adapter · 阶段 A
 *
 * 把 HTTP/SSE 来源的输入包装成 IngressMessage，交给 ingress gateway。
 *
 * 设计：
 *   - channel: "http"（不扩 ChannelType 枚举，沿用现有 http 名称）
 *   - 默认 transport=sse（W3 走 SSE 路径，不引入 ws 依赖；客户端 POST 提交、
 *     EventSource 收流；WS 升级留 P1+）
 *   - priority：与 cli 同——/approve / /deny 标 high
 */

import type { IngressMessage, IngressTransport } from "../channelAdapter";

export interface WebIngressOptions {
  /** Web 端点鉴权后拿到的稳定标识（通常是 token 派生 / 用户名） */
  userId: string;
  sessionId?: string | null;
  transport?: IngressTransport;
  /** 用户本次工作目录（Web 端点用户配置的项目根；前端可直接传） */
  workspace?: string;
  /** 来源 hint：直接调 / hook 触发 / 外部命令 */
  source?: "user" | "hook" | "command" | "system";
  parentToolUseId?: string;
  isInterrupt?: boolean;
}

const APPROVAL_PREFIXES = ["/approve", "/deny"];

function inferPriority(trimmed: string): "high" | "normal" {
  return APPROVAL_PREFIXES.some(
    (p) => trimmed === p || trimmed.startsWith(`${p} `)
  )
    ? "high"
    : "normal";
}

function inferSource(
  trimmed: string,
  hint?: WebIngressOptions["source"]
): "user" | "hook" | "command" | "system" {
  if (hint) return hint;
  return trimmed.startsWith("/") ? "command" : "user";
}

export function createWebIngressMessage(
  input: string,
  options: WebIngressOptions
): IngressMessage {
  const trimmed = input.trim();
  return {
    channel: "http",
    userId: options.userId,
    sessionId: options.sessionId ?? null,
    input,
    priority: inferPriority(trimmed),
    timestamp: Date.now(),
    metadata: {
      transport: options.transport ?? "sse",
      source: inferSource(trimmed, options.source),
      parentToolUseId: options.parentToolUseId,
      isInterrupt: options.isInterrupt,
      channelSpecific: options.workspace ? { workspace: options.workspace } : undefined,
    },
  };
}
