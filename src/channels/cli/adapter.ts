import type { IngressMessage } from "../channelAdapter";

export function createCliIngressMessage(
  input: string,
  options: {
    userId?: string;
    sessionId?: string | null;
    workspace?: string;
  } = {}
): IngressMessage {
  const trimmed = input.trim();

  return {
    channel: "cli",
    userId: options.userId ?? "local-user",
    sessionId: options.sessionId ?? null,
    input,
    priority: trimmed === "/approve" || trimmed === "/deny" || trimmed.startsWith("/approve ") || trimmed.startsWith("/deny ")
      ? "high"
      : "normal",
    timestamp: Date.now(),
    metadata: {
      transport: "stdin",
      source: trimmed.startsWith("/") ? "command" : "user",
      channelSpecific: options.workspace ? { workspace: options.workspace } : undefined
    }
  };
}
