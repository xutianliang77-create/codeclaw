import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryEngine } from "../src/agent/queryEngine";
import { loadIlinkWechatCredentials } from "../src/channels/wechat/token";
import { createWechatBotService } from "../src/channels/wechat/service";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("wechat worker", () => {
  it("loads token and baseUrl from token_file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codeclaw-wechat-token-"));
    tempDirs.push(dir);
    const tokenFile = path.join(dir, "token.json");
    await writeFile(
      tokenFile,
      JSON.stringify({
        bot_token: "wechat-token",
        baseurl: "http://127.0.0.1:8787",
        ilink_bot_id: "bot-1",
        ilink_user_id: "user-1"
      }),
      "utf8"
    );

    const credentials = await loadIlinkWechatCredentials(tokenFile);

    expect(credentials.token).toBe("wechat-token");
    expect(credentials.baseUrl).toBe("http://127.0.0.1:8787");
    expect(credentials.ilinkBotId).toBe("bot-1");
    expect(credentials.ilinkUserId).toBe("user-1");
  });

  it("polls updates and sends markdown replies back through sendMessage", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codeclaw-wechat-worker-"));
    tempDirs.push(dir);
    const tokenFile = path.join(dir, "token.json");
    await writeFile(
      tokenFile,
      JSON.stringify({
        bot_token: "wechat-token",
        baseurl: "http://127.0.0.1:8787",
        ilink_user_id: "bot-account"
      }),
      "utf8"
    );

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/ilink/bot/getupdates")) {
        return new Response(
          JSON.stringify({
            get_updates_buf: "buf-2",
            msgs: [
              {
                from_user_id: "user-1",
                client_id: "msg-1",
                message_type: 1,
                context_token: "ctx-1",
                item_list: [
                  {
                    type: 1,
                    text_item: {
                      text: "/help"
                    }
                  }
                ]
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (url.endsWith("/ilink/bot/sendmessage")) {
        return new Response(JSON.stringify({ ok: true, body: init?.body ?? null }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      throw new Error(`Unexpected url ${url}`);
    });

    const service = createWechatBotService({
      createQueryEngine() {
        return createQueryEngine({
          currentProvider: null,
          fallbackProvider: null,
          permissionMode: "plan",
          workspace: process.cwd()
        });
      }
    });
    const worker = service.createWorker({
      tokenFile,
      fetchImpl: fetchMock as typeof fetch
    });

    await worker.pollOnce();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8787/ilink/bot/getupdates");
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain("\"get_updates_buf\":\"\"");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://127.0.0.1:8787/ilink/bot/sendmessage");
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      AuthorizationType: "ilink_bot_token"
    });
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain("CodeClaw 微信 Bot");
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain("\"to_user_id\":\"user-1\"");
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain("\"context_token\":\"session-");
  });

  it("treats long-poll timeout as an empty poll instead of crashing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codeclaw-wechat-worker-"));
    tempDirs.push(dir);
    const tokenFile = path.join(dir, "token.json");
    await writeFile(
      tokenFile,
      JSON.stringify({
        bot_token: "wechat-token",
        baseurl: "http://127.0.0.1:8787",
        ilink_user_id: "bot-account"
      }),
      "utf8"
    );

    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    const service = createWechatBotService({
      createQueryEngine() {
        return createQueryEngine({
          currentProvider: null,
          fallbackProvider: null,
          permissionMode: "plan",
          workspace: process.cwd()
        });
      }
    });
    const worker = service.createWorker({
      tokenFile,
      fetchImpl: fetchMock as typeof fetch
    });

    await expect(worker.pollOnce()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
