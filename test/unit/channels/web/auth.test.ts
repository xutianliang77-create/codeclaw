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
  it("env 未设 → bearerToken=null（可能从默认文件路径读到 file，也接受）", () => {
    const cfg = readWebAuthConfig({});
    // env 没有时：bearerToken 要么 null（无文件），要么从 ~/.codeclaw/web-auth.json 读到（source=file）
    if (cfg.bearerToken === null) {
      expect(cfg.source ?? null).toBeNull();
    } else {
      expect(cfg.source).toBe("file");
    }
  });

  it("env 空字符串 → fallback 到文件 / null", () => {
    const cfg1 = readWebAuthConfig({ CODECLAW_WEB_TOKEN: "" });
    const cfg2 = readWebAuthConfig({ CODECLAW_WEB_TOKEN: "   " });
    // env 空白等同于未设；走 file fallback；任一来源即可
    expect(cfg1.source === "env").toBe(false);
    expect(cfg2.source === "env").toBe(false);
  });

  it("env 有值 → bearerToken 透传（trim），source=env", () => {
    const cfg1 = readWebAuthConfig({ CODECLAW_WEB_TOKEN: "secret123" });
    expect(cfg1.bearerToken).toBe("secret123");
    expect(cfg1.source).toBe("env");

    const cfg2 = readWebAuthConfig({ CODECLAW_WEB_TOKEN: "  pad  " });
    expect(cfg2.bearerToken).toBe("pad");
    expect(cfg2.source).toBe("env");
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
