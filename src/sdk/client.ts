import type { EngineEvent } from "../agent/types";
import type { GatewayEventEnvelope, GatewayMessageRequest } from "./types";

export class CodeClawSdkClient {
  constructor(
    private readonly baseUrl: string,
    private readonly authToken?: string
  ) {}

  async healthCheck(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/health`, {
      headers: this.buildHeaders()
    });

    return response.ok;
  }

  async sendMessage(request: GatewayMessageRequest): Promise<{
    sessionId: string;
    traceId: string | null;
    channel: "http";
    messages: Array<{ id: string; role: string; text: string }>;
    pendingApproval: unknown;
  }> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        ...this.buildHeaders(),
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`Gateway request failed (${response.status})`);
    }

    return (await response.json()) as {
      sessionId: string;
      traceId: string | null;
      channel: "http";
      messages: Array<{ id: string; role: string; text: string }>;
      pendingApproval: unknown;
    };
  }

  async *streamMessage(
    request: GatewayMessageRequest
  ): AsyncGenerator<GatewayEventEnvelope<EngineEvent>> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        ...this.buildHeaders(),
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({
        ...request,
        stream: true
      })
    });

    if (!response.ok || !response.body) {
      throw new Error(`Gateway stream failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const line = chunk
          .split("\n")
          .find((entry) => entry.startsWith("data: "));
        if (!line) {
          continue;
        }

        yield JSON.parse(line.slice("data: ".length)) as GatewayEventEnvelope<EngineEvent>;
      }
    }
  }

  async interrupt(sessionId?: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/interrupt`, {
      method: "POST",
      headers: {
        ...this.buildHeaders(),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sessionId
      })
    });

    if (!response.ok) {
      throw new Error(`Gateway interrupt failed (${response.status})`);
    }
  }

  private buildHeaders(): Record<string, string> {
    return this.authToken
      ? {
          Authorization: `Bearer ${this.authToken}`
        }
      : {};
  }
}
