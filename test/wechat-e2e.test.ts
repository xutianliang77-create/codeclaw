import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQueryEngine } from "../src/agent/queryEngine";
import { createWechatBotService } from "../src/channels/wechat/service";
import { handleIlinkWebhookPayload } from "../src/channels/wechat/handler";
import type { ProviderStatus } from "../src/provider/types";

const tempDirs: string[] = [];

const provider: ProviderStatus = {
  type: "lmstudio",
  displayName: "LM Studio",
  kind: "local",
  enabled: true,
  requiresApiKey: false,
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "qwen/qwen3.6-35b-a3b",
  timeoutMs: 60_000,
  apiKey: undefined,
  apiKeyEnvVar: undefined,
  envVars: [],
  fileConfig: {},
  configured: true,
  available: true,
  reason: "configured"
};

afterEach(async () => {
  await Promise.all(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("wechat end-to-end", () => {
  it("reuses the same session across approval and resume, then executes approved writes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-wechat-e2e-"));
    tempDirs.push(workspace);
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ scripts: { typecheck: "node -e \"process.stdout.write('ok')\"" } }),
      "utf8"
    );

    const service = createWechatBotService({
      createQueryEngine() {
        return createQueryEngine({
          currentProvider: provider,
          fallbackProvider: null,
          permissionMode: "plan",
          workspace
        });
      }
    });

    const first = await handleIlinkWebhookPayload(service.adapter, {
      events: [
        {
          event: "message",
          message: {
            id: "msg-1",
            content: {
              text: "/orchestrate create src/wechat-feature.ts"
            }
          },
          sender: {
            id: "user-1",
            name: "Alice"
          },
          chat: {
            id: "room-1",
            type: "group"
          }
        }
      ]
    });

    const contextToken = first.cards[0]?.contextToken;
    expect(first.cards[0]?.markdown).toContain("待审批");

    const resume = await handleIlinkWebhookPayload(service.adapter, {
      events: [
        {
          event: "resume",
          context_token: contextToken
        }
      ]
    });
    expect(resume.cards[0]?.markdown).toContain("CodeClaw 会话恢复");
    expect(resume.cards[0]?.markdown).toContain("/approve");

    const approved = await handleIlinkWebhookPayload(service.adapter, {
      events: [
        {
          event: "message",
          message: {
            id: "msg-2",
            content: {
              text: "/approve"
            }
          },
          sender: {
            id: "user-1",
            name: "Alice"
          },
          chat: {
            id: "room-1",
            type: "group"
          },
          context_token: contextToken
        }
      ]
    });

    const created = await readFile(path.join(workspace, "src/wechat-feature.ts"), "utf8");
    expect(approved.cards[0]?.contextToken).toBe(contextToken);
    expect(approved.cards[0]?.markdown).toContain("Approved orchestration write");
    expect(created).toContain("Generated scaffold for approved orchestration goal: create src/wechat-feature.ts");
  });
});
