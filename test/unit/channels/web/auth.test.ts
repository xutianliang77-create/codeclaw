/**
 * Web channel auth 单测
 */

import { describe, expect, it } from "vitest";
import {
  constantTimeEquals,
  readWebAuthConfig,
  validateBearer,
} from "../../../../src/channels/web/auth";

describe("readWebAuthConfig", () => {
  it("env 未设 → bearerToken=null", () => {
    expect(readWebAuthConfig({})).toEqual({ bearerToken: null });
  });

  it("env 空字符串 → null", () => {
    expect(readWebAuthConfig({ CODECLAW_WEB_TOKEN: "" })).toEqual({ bearerToken: null });
    expect(readWebAuthConfig({ CODECLAW_WEB_TOKEN: "   " })).toEqual({ bearerToken: null });
  });

  it("env 有值 → bearerToken 透传（trim）", () => {
    expect(readWebAuthConfig({ CODECLAW_WEB_TOKEN: "secret123" })).toEqual({
      bearerToken: "secret123",
    });
    expect(readWebAuthConfig({ CODECLAW_WEB_TOKEN: "  pad  " })).toEqual({
      bearerToken: "pad",
    });
  });
});

describe("constantTimeEquals", () => {
  it("等长 + 内容相同 → true", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
  });
  it("等长 + 内容不同 → false", () => {
    expect(constantTimeEquals("abc", "abd")).toBe(false);
  });
  it("不等长 → false", () => {
    expect(constantTimeEquals("a", "abc")).toBe(false);
    expect(constantTimeEquals("abcd", "abc")).toBe(false);
  });
  it("空字符串 vs 空字符串 → true", () => {
    expect(constantTimeEquals("", "")).toBe(true);
  });
});

describe("validateBearer", () => {
  it("expected=null → 永远 false（Web 禁用）", () => {
    expect(validateBearer("Bearer s", null)).toBe(false);
  });

  it("authHeader 缺失 → false", () => {
    expect(validateBearer(undefined, "secret")).toBe(false);
    expect(validateBearer("", "secret")).toBe(false);
  });

  it("非 Bearer scheme → false", () => {
    expect(validateBearer("Basic xxx", "secret")).toBe(false);
    expect(validateBearer("Token secret", "secret")).toBe(false);
  });

  it("Bearer 但 token 不匹配 → false", () => {
    expect(validateBearer("Bearer wrong", "secret")).toBe(false);
  });

  it("Bearer 正确匹配 → true", () => {
    expect(validateBearer("Bearer secret", "secret")).toBe(true);
  });

  it("Bearer 大小写不敏感 + 多空格容忍", () => {
    expect(validateBearer("bearer secret", "secret")).toBe(true);
    expect(validateBearer("Bearer  secret", "secret")).toBe(true); // 双空格
    expect(validateBearer("  Bearer secret  ", "secret")).toBe(true); // 首尾空白
  });
});
