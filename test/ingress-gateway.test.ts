import { describe, expect, it } from "vitest";
import { createQueryEngine } from "../src/agent/queryEngine";
import type { EngineEvent } from "../src/agent/types";
import { createCliIngressMessage } from "../src/channels/cli/adapter";
import { IngressGateway } from "../src/ingress/gateway";

async function collect<T>(stream: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

describe("ingress gateway", () => {
  it("wraps CLI input in a unified ingress flow with session and trace metadata", async () => {
    const queryEngine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "plan",
      workspace: process.cwd()
    });
    const gateway = new IngressGateway(queryEngine);

    const envelopes = await collect(
      gateway.handleMessage(
        createCliIngressMessage("help", {
          userId: "tester",
          workspace: process.cwd()
        })
      )
    );

    // P0-W1-06：traceId 升级为 ULID（26 char Crockford Base32，无 I/L/O/U）
    const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
    expect(envelopes.length).toBeGreaterThan(0);
    expect(envelopes.every((envelope) => envelope.sessionId === queryEngine.getSessionId())).toBe(true);
    expect(envelopes.every((envelope) => envelope.channel === "cli")).toBe(true);
    expect(envelopes.every((envelope) => ULID_RE.test(envelope.traceId))).toBe(true);
    expect(envelopes.some((envelope) => (envelope.payload as EngineEvent).type === "message-complete")).toBe(true);
  });

  it("reuses the same session mapping for the same channel and user", async () => {
    const queryEngine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "plan",
      workspace: process.cwd()
    });
    const gateway = new IngressGateway(queryEngine);

    await collect(
      gateway.handleMessage(
        createCliIngressMessage("first message", {
          userId: "tester"
        })
      )
    );
    await collect(
      gateway.handleMessage(
        createCliIngressMessage("second message", {
          userId: "tester"
        })
      )
    );

    const activeSessions = gateway.getActiveSessions();

    expect(activeSessions).toHaveLength(1);
    expect(activeSessions[0]?.channel).toBe("cli");
    expect(activeSessions[0]?.userId).toBe("tester");
    expect(activeSessions[0]?.sessionId).toBe(queryEngine.getSessionId());
  });
});
