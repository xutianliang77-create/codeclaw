/**
 * P0-W1-06 · ULID traceId 单测
 * 覆盖：格式合法性 / 并发唯一 / 同毫秒单调 / 时间戳解析
 */

import { describe, expect, it } from "vitest";
import {
  createEventId,
  createTraceId,
  isValidUlid,
  parseUlidTimestamp,
} from "../../../src/lib/traceId";

describe("createTraceId", () => {
  it("returns a 26-char Crockford Base32 ULID", () => {
    const id = createTraceId();
    expect(id).toHaveLength(26);
    expect(isValidUlid(id)).toBe(true);
  });

  it("monotonic within same millisecond", () => {
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) ids.push(createTraceId());
    // 按字典序排序应与生成顺序一致
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("scales to 100k generations without collision", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100_000; i++) ids.add(createTraceId());
    expect(ids.size).toBe(100_000);
  });

  it("parseUlidTimestamp round-trips to current time (±200ms)", () => {
    const before = Date.now();
    const id = createTraceId();
    const ts = parseUlidTimestamp(id);
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 1);
    expect(ts).toBeLessThanOrEqual(after + 200);
  });
});

describe("createEventId", () => {
  it("returns a ULID distinct from traceId", () => {
    const t = createTraceId();
    const e = createEventId();
    expect(isValidUlid(e)).toBe(true);
    expect(e).not.toBe(t);
  });
});

describe("isValidUlid", () => {
  it("accepts canonical ULIDs", () => {
    expect(isValidUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(isValidUlid(createTraceId())).toBe(true);
  });

  it("rejects wrong length", () => {
    expect(isValidUlid("01ARZ3")).toBe(false);
    expect(isValidUlid("")).toBe(false);
  });

  it("rejects forbidden letters (I / L / O / U)", () => {
    // 标准 Crockford Base32 排除 I, L, O, U
    expect(isValidUlid("01ARZ3NDEKTSV4RRFFQ69G5FAI")).toBe(false);
    expect(isValidUlid("01ARZ3NDEKTSV4RRFFQ69G5FAL")).toBe(false);
    expect(isValidUlid("01ARZ3NDEKTSV4RRFFQ69G5FAO")).toBe(false);
    expect(isValidUlid("01ARZ3NDEKTSV4RRFFQ69G5FAU")).toBe(false);
  });

  it("rejects non-string inputs gracefully", () => {
    // @ts-expect-error: deliberate runtime misuse
    expect(isValidUlid(null)).toBe(false);
    // @ts-expect-error: deliberate runtime misuse
    expect(isValidUlid(undefined)).toBe(false);
    // @ts-expect-error: deliberate runtime misuse
    expect(isValidUlid(12345)).toBe(false);
  });
});
