import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

function defaultWechatLogFile(): string {
  return path.join(os.homedir(), ".codeclaw", "logs", "wechat.log");
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
  /** 空轮询（无新消息）后下一轮间隔，默认 1000ms。设过低会让 idle 时高频 fetch 把 stderr 灌爆。 */
  pollIntervalMs?: number;
  fetchImpl?: FetchLike;
  /** ingress dedup db；不传则不去重 */
  dedupDb?: Database.Database;
  /** 连续失败的指数退避起始值（ms），默认 1000。每多一次失败 ×2，到 failureBackoffMaxMs 封顶。 */
  failureBackoffBaseMs?: number;
  /** 失败退避上限（ms），默认 60_000。 */
  failureBackoffMaxMs?: number;
  /** 失败连续超过该阈值后，停止往 stderr 写错误（改写日志文件）。默认 3。 */
  stderrFailureThreshold?: number;
  /** 失败日志路径；默认 ~/.codeclaw/logs/wechat.log。 */
  failureLogFile?: string;
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
    let consecutiveFailures = 0;
    while (!this.stopped) {
      let receivedMessages = false;
      try {
        receivedMessages = await this.pollOnce();
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures += 1;
        this.reportFailure(err, consecutiveFailures);
        if (this.stopped) return;
        const base = this.options.failureBackoffBaseMs ?? 1_000;
        const cap = this.options.failureBackoffMaxMs ?? 60_000;
        const backoff = Math.min(base * 2 ** Math.min(consecutiveFailures - 1, 6), cap);
        await sleep(backoff);
        continue;
      }
      if (this.stopped) {
        return;
      }
      if (!receivedMessages) {
        await sleep(this.options.pollIntervalMs ?? 1_000);
      }
    }
  }

  /**
   * 失败上报：前 N 次（stderrFailureThreshold）正常打到 stderr 让用户感知；
   * 超过阈值后只写日志文件，避免 idle 时 token 失效/网络断引发 stderr 雪崩
   * （上游终端 ANSI parser 可能扛不住）。
   */
  private reportFailure(err: unknown, count: number): void {
    const stack = err instanceof Error ? err.stack ?? err.message : String(err);
    const line = `[${new Date().toISOString()}] wechat poll failed (#${count}): ${stack}\n`;
    const threshold = this.options.stderrFailureThreshold ?? 3;
    if (count <= threshold) {
      process.stderr.write(line);
      if (count === threshold) {
        process.stderr.write(
          `[wechat] further failures suppressed; see ${this.options.failureLogFile ?? defaultWechatLogFile()}\n`
        );
      }
    }
    try {
      const logFile = this.options.failureLogFile ?? defaultWechatLogFile();
      mkdirSync(path.dirname(logFile), { recursive: true });
      appendFileSync(logFile, line, "utf8");
    } catch {
      // 写日志失败也吃掉；不能让日志失败再次拖垮 worker
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
    const outboundCards = this.options.adapter.drainOutboundQueue();
    const cards = [...result.cards, ...syncCards, ...outboundCards];

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
