/**
 * P0-W1-12 · CodeClawError 单测
 */

import { describe, expect, it } from "vitest";
import { CodeClawError, isCodeClawError, wrapAsCodeClawError } from "../../../src/lib/errors";

describe("CodeClawError", () => {
  it("constructs with code, message, context", () => {
    const err = new CodeClawError("ERR_PERMISSION_DENIED", "blocked by gate", {
      traceId: "t-1",
      action: "tool.bash",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("ERR_PERMISSION_DENIED");
    expect(err.message).toBe("blocked by gate");
    expect(err.context.traceId).toBe("t-1");
  });

  it("accepts ad-hoc string code (future compatible)", () => {
    const err = new CodeClawError("ERR_FUTURE_UNLISTED", "x");
    expect(err.code).toBe("ERR_FUTURE_UNLISTED");
  });

  it("preserves cause when it is an Error", () => {
    const original = new Error("original fail");
    const err = new CodeClawError("ERR_UNKNOWN", "wrap", { cause: original });
    // Node 内置 `cause` 字段
    expect((err as Error & { cause?: unknown }).cause).toBe(original);
  });

  it("toJSON serializes code, message, context, stack; cause gets summarized", () => {
    const original = new Error("origin");
    const err = new CodeClawError("ERR_UNKNOWN", "m", { cause: original, resource: "/tmp/x" });
    const json = err.toJSON();
    expect(json.code).toBe("ERR_UNKNOWN");
    expect(json.message).toBe("m");
    expect(json.context).toMatchObject({
      resource: "/tmp/x",
      cause: { name: "Error", message: "origin" },
    });
    expect(typeof json.stack).toBe("string");
  });

  it("toJSON omits undefined entries in context", () => {
    const err = new CodeClawError("ERR_UNKNOWN", "m", { traceId: undefined, action: "x" });
    const json = err.toJSON();
    expect(json.context).toEqual({ action: "x" });
  });
});

describe("isCodeClawError / wrapAsCodeClawError", () => {
  it("isCodeClawError recognizes instances only", () => {
    expect(isCodeClawError(new CodeClawError("ERR_UNKNOWN", "x"))).toBe(true);
    expect(isCodeClawError(new Error("plain"))).toBe(false);
    expect(isCodeClawError("string")).toBe(false);
    expect(isCodeClawError(null)).toBe(false);
  });

  it("wrapAsCodeClawError returns the same instance if already typed", () => {
    const err = new CodeClawError("ERR_UNKNOWN", "x");
    expect(wrapAsCodeClawError(err)).toBe(err);
  });

  it("wrapAsCodeClawError wraps plain Error with provided code", () => {
    const original = new TypeError("boom");
    const wrapped = wrapAsCodeClawError(original, "ERR_STORAGE_WRITE_FAILED", {
      resource: "data.db",
    });
    expect(wrapped).toBeInstanceOf(CodeClawError);
    expect(wrapped.code).toBe("ERR_STORAGE_WRITE_FAILED");
    expect(wrapped.message).toBe("boom");
    expect(wrapped.context.cause).toBe(original);
    expect(wrapped.context.resource).toBe("data.db");
  });

  it("wrapAsCodeClawError wraps non-Error inputs (string / unknown) into message", () => {
    const wrapped = wrapAsCodeClawError("something bad");
    expect(wrapped.code).toBe("ERR_UNKNOWN");
    expect(wrapped.message).toBe("something bad");
  });
});
