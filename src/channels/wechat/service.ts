import type { QueryEngine, QueryEngineOptions } from "../../agent/types";
import { WechatBotAdapter } from "./adapter";
import { startWechatWebhookServer } from "./handler";
import { IlinkWechatLoginManager } from "./loginManager";
import { IlinkWechatWorker } from "./worker";

export interface WechatBotService {
  adapter: WechatBotAdapter;
  attachSharedRuntime: (queryEngine: QueryEngine) => void;
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
}): WechatBotService {
  const adapter = new WechatBotAdapter(() =>
    options.createQueryEngine({
      ...options.defaultEngineOptions
    })
  );

  return {
    adapter,
    attachSharedRuntime(queryEngine) {
      adapter.attachSharedRuntime(queryEngine);
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
