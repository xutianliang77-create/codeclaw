import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type Database from "better-sqlite3";
import { WechatBotAdapter } from "./adapter";
import { handleIlinkWebhookPayload } from "./handler";
import { loadIlinkWechatCredentials } from "./token";

type FetchLike = typeof fetch;

const USER_MESSAGE_TYPE = 1;
const BOT_MESSAGE_TYPE = 2;
const MESSAGE_STATE_SENT = 2;
const TEXT_ITEM_TYPE = 1;
const LONG_POLL_TIMEOUT_MS = 35_000;

function joinUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
}

function createWechatUin(): string {
  return Buffer.from(String(Math.floor(Math.random() * 0xffffffff)), "utf8").toString("base64");
}

function buildHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": createWechatUin(),
    Authorization: `Bearer ${token}`
  };
}

async function postJson<T>(
  fetchImpl: FetchLike,
  url: string,
  token: string,
  payload: unknown,
  timeoutMs = LONG_POLL_TIMEOUT_MS
): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  }, timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`iLink request failed: ${response.status}`);
    }

    return (await response.json()) as T;
  } catch (error) {
    if ((error as Error).name === "AbortError" || (error as Error).name === "TimeoutError") {
      return null;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

type IlinkGetUpdatesResponse = {
  get_updates_buf?: string;
  msgs?: Array<{
    from_user_id?: string;
    to_user_id?: string;
    client_id?: string;
    message_type?: number;
    context_token?: string;
    item_list?: Array<{
      type?: number;
      text_item?: {
        text?: string;
      };
    }>;
  }>;
};

export interface IlinkWechatWorkerOptions {
  adapter: WechatBotAdapter;
  tokenFile: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  fetchImpl?: FetchLike;
  /** ingress dedup db；不传则不去重 */
  dedupDb?: Database.Database;
}

export class IlinkWechatWorker {
  private readonly fetchImpl: FetchLike;
  private stopped = false;
  private getUpdatesBuf = "";

  constructor(private readonly options: IlinkWechatWorkerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      const receivedMessages = await this.pollOnce();
      if (this.stopped) {
        return;
      }

      if (!receivedMessages) {
        await sleep(this.options.pollIntervalMs ?? 100);
      }
    }
  }

  async pollOnce(): Promise<boolean> {
    const credentials = await loadIlinkWechatCredentials(this.options.tokenFile);
    const baseUrl = this.options.baseUrl ?? credentials.baseUrl;

    const payload = await postJson<IlinkGetUpdatesResponse>(
      this.fetchImpl,
      joinUrl(baseUrl, "ilink/bot/getupdates"),
      credentials.token,
      {
        get_updates_buf: this.getUpdatesBuf
      }
    );

    if (!payload) {
      return false;
    }

    if (typeof payload.get_updates_buf === "string" && payload.get_updates_buf) {
      this.getUpdatesBuf = payload.get_updates_buf;
    }

    const receivedMessages = Boolean(payload.msgs?.length);
    const result = await handleIlinkWebhookPayload(this.options.adapter, payload, {
      dedupDb: this.options.dedupDb,
    });
    const syncCards = this.options.adapter.buildSessionUpdateCards();
    const cards = [...result.cards, ...syncCards];

    for (const card of cards) {
      if (!card.replyTarget) {
        continue;
      }

      await postJson(
        this.fetchImpl,
        joinUrl(baseUrl, "ilink/bot/sendmessage"),
        credentials.token,
        {
          msg: {
            from_user_id: credentials.ilinkUserId ?? "",
            to_user_id: card.replyTarget.senderId,
            client_id: randomUUID(),
            message_type: BOT_MESSAGE_TYPE,
            message_state: MESSAGE_STATE_SENT,
            item_list: [
              {
                type: TEXT_ITEM_TYPE,
                text_item: {
                  text: card.markdown
                }
              }
            ],
            context_token: card.contextToken
          }
        },
        10_000
      );
    }

    return receivedMessages || syncCards.length > 0;
  }
}

export {
  USER_MESSAGE_TYPE,
  BOT_MESSAGE_TYPE,
  MESSAGE_STATE_SENT,
  TEXT_ITEM_TYPE
};
