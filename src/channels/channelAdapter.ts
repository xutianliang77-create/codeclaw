export type ChannelType = "cli" | "sdk" | "wechat" | "mcp" | "http";

export type IngressPriority = "high" | "normal";

export type IngressTransport = "stdio" | "ws" | "sse" | "rest" | "stdin";

export type IngressSource = "user" | "hook" | "command" | "system";

export interface IngressMessage {
  channel: ChannelType;
  userId: string;
  sessionId: string | null;
  input: string;
  priority: IngressPriority;
  timestamp: number;
  metadata: {
    transport?: IngressTransport;
    source?: IngressSource;
    parentToolUseId?: string;
    isInterrupt?: boolean;
    channelSpecific?: Record<string, unknown>;
  };
}

export interface ResolvedIngressMessage extends IngressMessage {
  sessionId: string;
  traceId: string;
}

export interface DeliveryEnvelope<TPayload> {
  sessionId: string;
  traceId: string;
  channel: ChannelType;
  timestamp: number;
  payload: TPayload;
}
