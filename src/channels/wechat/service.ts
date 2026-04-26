import type { QueryEngine, QueryEngineOptions } from "../../agent/types";
import { WechatBotAdapter } from "./adapter";
import { startWechatWebhookServer } from "./handler";
import { IlinkWechatLoginManager } from "./loginManager";
import { IlinkWechatWorker } from "./worker";
import type { SpeechTranscriber } from "../../provider/speech";

export interface WechatBotService {
  adapter: WechatBotAdapter;
  attachSharedRuntime: (queryEngine: QueryEngine) => void;
  /**
   * #116 阶段 🅑：把一条文本入外发队列，下次 worker poll 时投递给最近活跃的 wechat 会话。
   * 返回 false 表示无 active 接收方（用户从未发过消息），消息被丢弃。
   * 仅 worker 模式生效（webhook 模式无 poll 通道，外发要等用户下次发消息触发同步）。
   */
  sendToActive: (text: string) => boolean;
  start: (options?: { port?: number; authToken?: string | null }) => ReturnType<typeof startWechatWebhookServer>;
  createWorker: (options: {
    tokenFile: string;
    baseUrl?: string;
    pollIntervalMs?: number;
    fetchImpl?: typeof fetch;
  }) => IlinkWechatWorker;
  createLoginManager: (options: {
    tokenFile: string;
    baseUrl: string;
    fetchImpl?: typeof fetch;
    pollIntervalMs?: number;
    maxPollRounds?: number;
    onConfirmed?: (state: {
      phase: "idle" | "waiting" | "scanned" | "confirmed" | "expired" | "error";
      qrcode?: string;
      qrcodeImageContent?: string;
      tokenFile: string;
      baseUrl: string;
      message: string;
      ilinkBotId?: string;
      ilinkUserId?: string;
    }) => void | Promise<void>;
  }) => IlinkWechatLoginManager;
}

export function createWechatBotService(options: {
  createQueryEngine: (overrides?: Partial<QueryEngineOptions>) => QueryEngine;
  defaultEngineOptions?: Partial<QueryEngineOptions>;
  fetchImpl?: typeof fetch;
  mediaCacheDir?: string;
  transcribeAudio?: SpeechTranscriber;
}): WechatBotService {
  const adapter = new WechatBotAdapter(
    () =>
      options.createQueryEngine({
        ...options.defaultEngineOptions
      }),
    {
      fetchImpl: options.fetchImpl,
      mediaCacheDir: options.mediaCacheDir,
      transcribeAudio: options.transcribeAudio
    }
  );

  return {
    adapter,
    attachSharedRuntime(queryEngine) {
      adapter.attachSharedRuntime(queryEngine);
    },
    sendToActive(text) {
      return adapter.enqueueOutboundText(text);
    },
    start(startOptions) {
      return startWechatWebhookServer({
        adapter,
        port: startOptions?.port,
        authToken: startOptions?.authToken
      });
    },
    createWorker(workerOptions) {
      return new IlinkWechatWorker({
        adapter,
        tokenFile: workerOptions.tokenFile,
        baseUrl: workerOptions.baseUrl,
        pollIntervalMs: workerOptions.pollIntervalMs,
        fetchImpl: workerOptions.fetchImpl
      });
    },
    createLoginManager(loginOptions) {
      return new IlinkWechatLoginManager({
        tokenFile: loginOptions.tokenFile,
        baseUrl: loginOptions.baseUrl,
        fetchImpl: loginOptions.fetchImpl,
        pollIntervalMs: loginOptions.pollIntervalMs,
        maxPollRounds: loginOptions.maxPollRounds,
        onConfirmed: loginOptions.onConfirmed
      });
    }
  };
}
