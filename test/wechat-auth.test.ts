import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IlinkWechatLoginManager } from "../src/channels/wechat/loginManager";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("wechat auth", () => {
  it("starts qr login and persists confirmed credentials", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codeclaw-wechat-auth-"));
    tempDirs.push(dir);
    const tokenFile = path.join(dir, "token.json");

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes("get_bot_qrcode")) {
        return new Response(
          JSON.stringify({
            data: {
              qrcode: "qr-1",
              qrcode_img_content: "https://example.test/qr.png"
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes("get_qrcode_status")) {
        return new Response(
          JSON.stringify({
            data: {
              status: "confirmed",
              bot_token: "wechat-token",
              ilink_bot_id: "bot-1",
              ilink_user_id: "user-1"
            }
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected url ${url}`);
    });

    const manager = new IlinkWechatLoginManager({
      tokenFile,
      baseUrl: "https://ilinkai.weixin.qq.com",
      fetchImpl: fetchMock as typeof fetch,
      pollIntervalMs: 0,
      maxPollRounds: 1
    });

    const waiting = await manager.ensureStarted();
    expect(waiting.phase).toBe("waiting");
    expect(waiting.qrcode).toBe("qr-1");

    let state = await manager.refreshStatus();
    for (let attempt = 0; attempt < 5 && state.phase !== "confirmed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      state = await manager.refreshStatus();
    }

    expect(state.phase).toBe("confirmed");
    expect(state.ilinkBotId).toBe("bot-1");
    expect(state.ilinkUserId).toBe("user-1");

    const persisted = JSON.parse(await readFile(tokenFile, "utf8")) as Record<string, string>;
    expect(persisted.bot_token).toBe("wechat-token");
    expect(persisted.baseurl).toBe("https://ilinkai.weixin.qq.com");
  });

  it("calls onConfirmed when login reaches confirmed state", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codeclaw-wechat-auth-"));
    tempDirs.push(dir);
    const tokenFile = path.join(dir, "token.json");
    const onConfirmed = vi.fn();

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes("get_bot_qrcode")) {
        return new Response(
          JSON.stringify({
            data: {
              qrcode: "qr-2",
              qrcode_img_content: "https://example.test/qr-2.png"
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes("get_qrcode_status")) {
        return new Response(
          JSON.stringify({
            data: {
              status: "confirmed",
              bot_token: "wechat-token-2",
              ilink_bot_id: "bot-2",
              ilink_user_id: "user-2"
            }
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected url ${url}`);
    });

    const manager = new IlinkWechatLoginManager({
      tokenFile,
      baseUrl: "https://ilinkai.weixin.qq.com",
      fetchImpl: fetchMock as typeof fetch,
      pollIntervalMs: 0,
      maxPollRounds: 1,
      onConfirmed
    });

    await manager.ensureStarted();
    for (let attempt = 0; attempt < 5 && onConfirmed.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await manager.refreshStatus();
    }

    expect(onConfirmed).toHaveBeenCalled();
    expect(onConfirmed.mock.calls.at(-1)?.[0]).toMatchObject({
      phase: "confirmed",
      ilinkBotId: "bot-2",
      ilinkUserId: "user-2"
    });
  });
});
