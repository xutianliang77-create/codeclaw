import type { EngineEvent, QueryEngine } from "../agent/types";
import type { DeliveryEnvelope, IngressMessage, ResolvedIngressMessage } from "../channels/channelAdapter";
import { SessionManager, type SessionInfo } from "./sessionManager";

function createTraceId(): string {
  return `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class IngressGateway {
  private readonly sessionManager: SessionManager;

  constructor(
    private readonly queryEngine: QueryEngine,
    sessionManager?: SessionManager
  ) {
    this.sessionManager = sessionManager ?? new SessionManager();
  }

  async *handleMessage(
    message: IngressMessage
  ): AsyncGenerator<DeliveryEnvelope<EngineEvent>> {
    const resolved = this.resolveMessage(message);

    if (resolved.metadata.isInterrupt) {
      this.handleInterrupt(resolved.sessionId);
      yield {
        sessionId: resolved.sessionId,
        traceId: resolved.traceId,
        channel: resolved.channel,
        timestamp: Date.now(),
        payload: {
          type: "phase",
          phase: "halted"
        }
      };
      return;
    }

    for await (const event of this.queryEngine.submitMessage(resolved.input)) {
      yield {
        sessionId: resolved.sessionId,
        traceId: resolved.traceId,
        channel: resolved.channel,
        timestamp: Date.now(),
        payload: event
      };
    }

    this.sessionManager.touch(resolved.sessionId);
  }

  handleInterrupt(sessionId: string): void {
    if (sessionId === this.queryEngine.getSessionId()) {
      this.queryEngine.interrupt();
    }
  }

  getActiveSessions(): SessionInfo[] {
    return this.sessionManager.list();
  }

  destroySession(sessionId: string): void {
    this.sessionManager.destroy(sessionId);
  }

  private resolveMessage(message: IngressMessage): ResolvedIngressMessage {
    const fallbackSessionId = message.sessionId ?? this.queryEngine.getSessionId();
    const session = this.sessionManager.resolve(message.channel, message.userId, fallbackSessionId);

    return {
      ...message,
      sessionId: session.sessionId,
      traceId: createTraceId()
    };
  }
}
