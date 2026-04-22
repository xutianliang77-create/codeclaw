export interface GatewayMessageRequest {
  input: string;
  userId?: string;
  sessionId?: string | null;
  stream?: boolean;
}

export interface GatewayEventEnvelope<TPayload = unknown> {
  sessionId: string;
  traceId: string;
  channel: "sdk" | "http" | "cli" | "wechat" | "mcp";
  timestamp: number;
  payload: TPayload;
}

export interface GatewayHealthResponse {
  status: "ok";
  service: "codeclaw-gateway";
}
