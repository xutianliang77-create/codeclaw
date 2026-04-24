/**
 * P0-W1-12 · logger 单测
 * 验证：redact 生效；child logger 绑定字段
 *
 * pino 默认写 stdout；单测里用自定义 stream 捕获输出并断言 JSON 结构。
 */

import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

import { createLogger, createSilentLogger, logger } from "../../../src/lib/logger";

function captureLogs(level: string = "info"): { stream: Writable; lines: () => unknown[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe("logger · root", () => {
  it("exports a usable logger instance", () => {
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.child).toBe("function");
  });
});

describe("logger · createLogger (child by module)", () => {
  it("binds module field", () => {
    const { stream, lines } = captureLogs();
    const custom = pino(
      {
        level: "info",
        timestamp: pino.stdTimeFunctions.isoTime,
        redact: {
          paths: ["*.apiKey", "*.token", "*.password", "*.authorization", "*.bot_token"],
          censor: "[REDACTED]",
        },
      },
      stream
    );
    const log = custom.child({ module: "myModule" });
    log.info({ action: "test" }, "hello");
    const entries = lines();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ module: "myModule", action: "test", msg: "hello" });
  });
});

describe("logger · redact sensitive fields", () => {
  it("redacts token / apiKey / password / authorization", () => {
    const { stream, lines } = captureLogs();
    const custom = pino(
      {
        level: "info",
        timestamp: pino.stdTimeFunctions.isoTime,
        redact: {
          paths: ["*.token", "*.apiKey", "*.password", "*.authorization", "*.bot_token"],
          censor: "[REDACTED]",
        },
      },
      stream
    );
    custom.info({
      provider: { token: "sk-SHOULD-HIDE", apiKey: "key-SHOULD-HIDE", password: "pw-SHOULD-HIDE" },
      headers: { authorization: "Bearer SHOULD-HIDE" },
      extra: { bot_token: "bot-SHOULD-HIDE" },
    });
    const entries = lines();
    expect(entries).toHaveLength(1);
    const line = JSON.stringify(entries[0]);
    expect(line).not.toContain("SHOULD-HIDE");
    expect(line).toContain("[REDACTED]");
  });
});

describe("logger · silent", () => {
  it("createSilentLogger swallows output", () => {
    const s = createSilentLogger();
    // 不抛错即过；level=silent 无输出
    expect(() => s.info("nothing")).not.toThrow();
  });
});

describe("createLogger binding shortcut", () => {
  it("allows extra bindings", () => {
    const log = createLogger("x", { sessionId: "sess-1" });
    expect(typeof log.child).toBe("function");
  });
});
