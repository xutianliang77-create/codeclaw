import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQueryEngine } from "../src/agent/queryEngine";
import type { EngineEvent } from "../src/agent/types";
import { createCliIngressMessage } from "../src/channels/cli/adapter";
import { IngressGateway } from "../src/ingress/gateway";
import type { ProviderStatus } from "../src/provider/types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

const provider: ProviderStatus = {
  type: "openai",
  displayName: "OpenAI",
  kind: "cloud",
  enabled: true,
  requiresApiKey: true,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  timeoutMs: 30_000,
  apiKey: "test-key",
  apiKeyEnvVar: "OPENAI_API_KEY",
  envVars: ["OPENAI_API_KEY"],
  fileConfig: {},
  configured: true,
  available: true,
  reason: "configured"
};

async function collectPayloads(stream: AsyncGenerator<{ payload: EngineEvent }>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const envelope of stream) {
    events.push(envelope.payload);
  }

  return events;
}

describe("query engine end-to-end", () => {
  it("runs a review lane and an MCP lane through ingress with one shared session", async () => {
    process.env.CODECLAW_ENABLE_REAL_LSP = "0";
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-e2e-"));
    tempDirs.push(workspace);
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "codeclaw" }), "utf8");
    await writeFile(path.join(workspace, "sample.ts"), "export function greetUser(name: string) {\n  return name;\n}\n", "utf8");

    const engine = createQueryEngine({
      currentProvider: provider,
      fallbackProvider: null,
      permissionMode: "plan",
      workspace
    });
    const gateway = new IngressGateway(engine);

    await collectPayloads(
      gateway.handleMessage(
        createCliIngressMessage("/skills use review", {
          userId: "e2e-user",
          sessionId: engine.getSessionId(),
          workspace
        })
      )
    );
    await collectPayloads(
      gateway.handleMessage(
        createCliIngressMessage("/review sample.ts greetUser", {
          userId: "e2e-user",
          sessionId: engine.getSessionId(),
          workspace
        })
      )
    );
    await collectPayloads(
      gateway.handleMessage(
        createCliIngressMessage("/mcp read workspace-mcp workspace://summary", {
          userId: "e2e-user",
          sessionId: engine.getSessionId(),
          workspace
        })
      )
    );

    const sessions = gateway.getActiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe(engine.getSessionId());
    expect(engine.getMessages().some((message) => message.text.includes("Review"))).toBe(true);
    expect(engine.getMessages().some((message) => message.text.includes("Workspace Summary"))).toBe(true);
  });

  it("runs orchestration approval and export end-to-end through ingress", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-e2e-"));
    tempDirs.push(workspace);
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ scripts: { typecheck: "node -e \"process.stdout.write('ok')\"" } }),
      "utf8"
    );

    const engine = createQueryEngine({
      currentProvider: provider,
      fallbackProvider: null,
      permissionMode: "plan",
      workspace
    });
    const gateway = new IngressGateway(engine);

    await collectPayloads(
      gateway.handleMessage(
        createCliIngressMessage("/orchestrate create src/new-feature.ts", {
          userId: "e2e-user",
          sessionId: engine.getSessionId(),
          workspace
        })
      )
    );
    await collectPayloads(
      gateway.handleMessage(
        createCliIngressMessage("/approve", {
          userId: "e2e-user",
          sessionId: engine.getSessionId(),
          workspace
        })
      )
    );
    await collectPayloads(
      gateway.handleMessage(
        createCliIngressMessage("/export evidence/e2e-session.md", {
          userId: "e2e-user",
          sessionId: engine.getSessionId(),
          workspace
        })
      )
    );

    const createdContent = await readFile(path.join(workspace, "src/new-feature.ts"), "utf8");
    const exported = await readFile(path.join(workspace, "evidence/e2e-session.md"), "utf8");

    expect(createdContent).toContain("Generated scaffold for approved orchestration goal: create src/new-feature.ts");
    expect(exported).toContain("/orchestrate create src/new-feature.ts");
    expect(exported).toContain("Approved orchestration write: src/new-feature.ts");
  });

  it("keeps provider, skill, and command lanes isolated in one transcript", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-e2e-"));
    tempDirs.push(workspace);
    const requests: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> });

      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"model-lane-ok"}}]}\n'));
            controller.close();
          }
        })
      );
    };

    const engine = createQueryEngine({
      currentProvider: provider,
      fallbackProvider: null,
      permissionMode: "plan",
      workspace,
      fetchImpl: fetchImpl as typeof fetch
    });
    const gateway = new IngressGateway(engine);

    await collectPayloads(
      gateway.handleMessage(
        createCliIngressMessage("/skills use explain", {
          userId: "e2e-user",
          sessionId: engine.getSessionId(),
          workspace
        })
      )
    );
    await collectPayloads(
      gateway.handleMessage(
        createCliIngressMessage("/summary", {
          userId: "e2e-user",
          sessionId: engine.getSessionId(),
          workspace
        })
      )
    );
    await collectPayloads(
      gateway.handleMessage(
        createCliIngressMessage("explain the current session state", {
          userId: "e2e-user",
          sessionId: engine.getSessionId(),
          workspace
        })
      )
    );

    expect(requests).toHaveLength(1);
    // M1-A：skill prompt 搬到 system message；user 消息保持原样
    const sysContent = requests[0]?.messages?.[0]?.content;
    const userContent = requests[0]?.messages?.[1]?.content;
    expect(requests[0]?.messages?.[0]?.role).toBe("system");
    expect(sysContent).toContain("explain");
    expect(userContent).toContain("explain the current session state");
    expect(engine.getMessages().some((message) => message.text.includes("Summary"))).toBe(true);
    expect(engine.getMessages().at(-1)?.text).toContain("model-lane-ok");
  });
});
