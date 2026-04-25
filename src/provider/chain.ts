/**
 * Provider chain · #69 · W3-17 另一半
 *
 * 在 providers 列表上做 retry + fallback 编排：
 *   - transient 错误（5xx / ECONNRESET / 429 / timeout）→ 同 provider 指数退避 retry
 *   - auth / content / unknown → 不 retry，直接切下一个 provider
 *   - abort → 不 retry，向上抛
 *   - 已经 yield 过 chunk（partial output） → 不 retry / 不 fallback（避免用户看到重叠）
 *
 * 调用方负责 invoke 函数：给定 provider 返回 AsyncIterable<string>。
 * chain 不感知 streaming 协议本身，只编排「哪个 provider 试 / 试几次 / 何时退」。
 *
 * onAttempt 回调把每次 attempt（成败）汇报给上层做日志 / audit。
 */

import { ProviderRequestError } from "./client";
import type { ProviderStatus } from "./types";

export type ProviderErrorClass =
  | "transient" // 网络抖动 / 5xx / 429 / timeout：可 retry
  | "auth" // 401/403：换 provider 才有意义
  | "content" // 413/422：请求本身有问题，retry 无意义
  | "abort" // 用户主动中断
  | "unknown";

export function classifyProviderError(err: unknown): ProviderErrorClass {
  if (!err) return "unknown";
  const e = err as Error;
  if (e.name === "AbortError") return "abort";
  if (e instanceof ProviderRequestError) {
    const status = e.statusCode;
    if (status === undefined) return "transient";
    if (status === 401 || status === 403) return "auth";
    if (status === 408 || status === 425 || status === 429) return "transient";
    if (status >= 500 && status < 600) return "transient";
    if (status === 413 || status === 422) return "content";
    return "unknown";
  }
  const msg = e.message ?? "";
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|network/i.test(msg)) {
    return "transient";
  }
  if (/aborted|AbortError/i.test(msg)) return "abort";
  return "unknown";
}

export interface ChainAttempt {
  /** provider.type */
  provider: string;
  /** 1-based 尝试次数（同 provider 内） */
  attemptNo: number;
  ok: boolean;
  errorClass?: ProviderErrorClass;
  errorMessage?: string;
  durationMs: number;
}

export interface RunChainOptions {
  providers: ProviderStatus[];
  /** 同 provider transient 最大 retry 次数；默认 2（即首次 + 最多 2 次重试 = 3 次） */
  maxRetriesPerProvider?: number;
  /** 退避基数 ms；第 n 次重试 sleep = base * 2^(n-1)；默认 500 */
  backoffBaseMs?: number;
  /** 单个 attempt 函数：拿到 provider 返回流；上层提供，chain 不感知协议 */
  invoke: (provider: ProviderStatus) => AsyncIterable<string>;
  abortSignal?: AbortSignal;
  /** 每次 attempt 结束（成败都触发）回调 */
  onAttempt?: (attempt: ChainAttempt) => void;
  /** 自定义 sleep；测试用，默认 setTimeout */
  sleepImpl?: (ms: number, abortSignal?: AbortSignal) => Promise<void>;
}

export interface RunChainResult {
  ok: boolean;
  attempts: ChainAttempt[];
  /** 全部失败时的最后一次错误 */
  lastError?: Error;
  lastErrorClass?: ProviderErrorClass;
  /** 真正命中并拿到 stream 的 provider type */
  succeededProvider?: string;
}

const defaultSleep = (ms: number, abortSignal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * 跑 provider chain；以 AsyncGenerator 形式吐 chunks。
 * 全部 provider + retry 尝试结束后通过 returnValue 返回详细 attempts；
 * 上层用 `const result = yield* runWithProviderChain(...)` 获取。
 *
 * 不抛 abort 之外的错（chain 自己吃掉所有 provider 抛错），仅在 abort 时 throw。
 */
export async function* runWithProviderChain(
  opts: RunChainOptions
): AsyncGenerator<string, RunChainResult> {
  const maxRetries = opts.maxRetriesPerProvider ?? 2;
  const backoffBase = opts.backoffBaseMs ?? 500;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const attempts: ChainAttempt[] = [];
  let lastError: Error | undefined;
  let lastErrorClass: ProviderErrorClass | undefined;
  let producedAny = false;

  for (const provider of opts.providers) {
    let attemptNo = 0;
    while (attemptNo <= maxRetries) {
      if (opts.abortSignal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      attemptNo += 1;
      const start = Date.now();
      try {
        for await (const chunk of opts.invoke(provider)) {
          producedAny = true;
          yield chunk;
        }
        const attempt: ChainAttempt = {
          provider: provider.type,
          attemptNo,
          ok: true,
          durationMs: Date.now() - start,
        };
        attempts.push(attempt);
        opts.onAttempt?.(attempt);
        return { ok: true, attempts, succeededProvider: provider.type };
      } catch (err) {
        const errorClass = classifyProviderError(err);
        lastError = err as Error;
        lastErrorClass = errorClass;
        const attempt: ChainAttempt = {
          provider: provider.type,
          attemptNo,
          ok: false,
          errorClass,
          errorMessage: (err as Error).message,
          durationMs: Date.now() - start,
        };
        attempts.push(attempt);
        opts.onAttempt?.(attempt);

        if (errorClass === "abort") {
          throw err;
        }

        // 已经向用户吐过 chunk → stream 中断，无法重试 / 切 fallback
        if (producedAny) {
          return { ok: false, attempts, lastError, lastErrorClass };
        }

        // transient 在同 provider 内 retry（attemptNo 已 +1，比较 maxRetries 的判断逻辑见下）
        if (errorClass === "transient" && attemptNo <= maxRetries) {
          const backoff = backoffBase * 2 ** (attemptNo - 1);
          await sleep(backoff, opts.abortSignal);
          continue;
        }
        break; // 切下一个 provider
      }
    }
  }

  return { ok: false, attempts, lastError, lastErrorClass };
}
