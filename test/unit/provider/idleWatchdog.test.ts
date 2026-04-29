import { describe, expect, it } from "vitest";
import { readWithIdleTimeout } from "../../../src/provider/client";

// v0.8.6：流式 chunk idle watchdog 直接单测；mock reader 接口绕过 Node ReadableStream 实现差异。
// 治理场景：LM Studio 27B 偶尔 hang（GPU OOM / 模型加载失败 / 循环检测），chunk 永远不来。

interface MockReader<T> {
  read(): Promise<{ done: false; value: T } | { done: true; value?: undefined }>;
  cancel(): Promise<void>;
}

function makeIdleReader(): { reader: MockReader<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  return {
    reader: {
      read: () =>
        new Promise(() => {
          /* never resolve, simulate hung backend */
        }),
      cancel: async () => {
        cancelled = true;
      }
    },
    cancelled: () => cancelled
  };
}

describe("readWithIdleTimeout", () => {
  it("[v0.8.6] reader 立即返回 chunk → 正常 resolve", async () => {
    const reader: MockReader<Uint8Array> = {
      read: async () => ({ done: false, value: new Uint8Array([1, 2, 3]) }),
      cancel: async () => {
        /* noop */
      }
    };
    const result = await readWithIdleTimeout(reader as never, 1000);
    expect(result.done).toBe(false);
    if (!result.done) expect(result.value).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("[v0.8.6] reader 永远 idle → timeout 后 reject 含 'Stream idle timeout'", async () => {
    const { reader } = makeIdleReader();
    await expect(readWithIdleTimeout(reader as never, 50)).rejects.toThrow(/Stream idle timeout/);
  });

  it("[v0.8.6] timeout 触发后 reader 被 cancel（防资源泄漏）", async () => {
    const { reader, cancelled } = makeIdleReader();
    await expect(readWithIdleTimeout(reader as never, 30)).rejects.toThrow();
    expect(cancelled()).toBe(true);
  });

  it("[v0.8.6] error message 提示用户如何用 env 调阈值", async () => {
    const { reader } = makeIdleReader();
    try {
      await readWithIdleTimeout(reader as never, 30);
      throw new Error("should have rejected");
    } catch (err) {
      expect((err as Error).message).toContain("CODECLAW_STREAM_IDLE_MS");
    }
  });
});
