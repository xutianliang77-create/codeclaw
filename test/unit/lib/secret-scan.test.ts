/**
 * secretScan 单测 · W4-05/06
 *
 * 每条规则一个 fixture + 反向测试（无 secret 不误报）+ 行号精确性 +
 * formatFindings 输出格式。
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  formatFindings,
  scanForSecrets,
} from "../../../src/lib/secretScan";

describe("scanForSecrets · 命中规则", () => {
  it("AWS access key", () => {
    const r = scanForSecrets("config: AKIAIOSFODNN7EXAMPLE = real");
    expect(r).toHaveLength(1);
    expect(r[0].rule).toBe("aws-access-key");
    expect(r[0].severity).toBe("high");
  });

  it("GitHub personal token", () => {
    const r = scanForSecrets("token = ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(r[0].rule).toBe("github-token");
  });

  it("OpenAI key", () => {
    const r = scanForSecrets("OPENAI_API_KEY=sk-proj-abc123def456ghij");
    expect(r[0].rule).toBe("openai-key");
  });

  it("Anthropic key", () => {
    const r = scanForSecrets("CLAUDE_KEY=sk-ant-abcd1234efgh5678ijkl");
    expect(r[0].rule).toBe("anthropic-key");
  });

  it("Google API key", () => {
    const r = scanForSecrets("GOOG=AIzaAbcdefghijklmnopqrstuvwxyz0123456789");
    expect(r[0].rule).toBe("google-api-key");
  });

  it("Slack token", () => {
    const r = scanForSecrets("slack-bot xoxb-1234567890-abc");
    expect(r[0].rule).toBe("slack-token");
  });

  it("PEM 私钥头", () => {
    const r = scanForSecrets("\n-----BEGIN RSA PRIVATE KEY-----\nXXX\n");
    expect(r[0].rule).toBe("private-key-header");
  });

  it("JWT 形似（三段 base64url）", () => {
    const r = scanForSecrets(
      "auth: eyJabc1234567890.eyJpc3MiOiJleGFtcGxlIn0.abcdefghijklmn"
    );
    expect(r[0].rule).toBe("jwt-likely");
    expect(r[0].severity).toBe("medium");
  });

  it("硬编码 password 赋值", () => {
    const r = scanForSecrets('const cfg = { password: "supersecret" };');
    expect(r[0].rule).toBe("generic-password-assign");
  });

  it("PEM EC / OPENSSH 变体也命中", () => {
    expect(
      scanForSecrets("-----BEGIN EC PRIVATE KEY-----\n...")[0]?.rule
    ).toBe("private-key-header");
    expect(
      scanForSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\n...")[0]?.rule
    ).toBe("private-key-header");
  });
});

describe("scanForSecrets · 反向 / 性能", () => {
  it("普通文本 → 0 命中", () => {
    expect(scanForSecrets("普通的中英文文本，没有密钥。")).toEqual([]);
    expect(scanForSecrets("function add(a, b) { return a + b; }")).toEqual([]);
  });

  it("空字符串 / null-ish → []", () => {
    expect(scanForSecrets("")).toEqual([]);
  });

  it("看似但太短的不命中（AKIA 长度不够）", () => {
    expect(scanForSecrets("AKIA12345")).toEqual([]);
  });

  it("看似但太短的不命中（GitHub token 不够 36 字符）", () => {
    expect(scanForSecrets("ghp_short")).toEqual([]);
  });

  it("多种 secrets 混合 → 各自命中", () => {
    const text =
      "AKIAIOSFODNN7EXAMPLE\nghp_abcdefghijklmnopqrstuvwxyz0123456789\nsk-proj-abc123def456ghij7890";
    const r = scanForSecrets(text);
    const rules = r.map((f) => f.rule).sort();
    expect(rules).toEqual(["aws-access-key", "github-token", "openai-key"]);
  });

  it("行号精确（多行输入）", () => {
    const text = "line1\nline2\nleak: AKIAIOSFODNN7EXAMPLE\nline4";
    const r = scanForSecrets(text);
    expect(r[0].line).toBe(3);
  });

  it("超长 match 截断到 64 字符 + 省略号", () => {
    // 用 PEM 头 + 一段长正文构造特殊 case；用 generic 规则更自然：
    const text = 'pwd: "' + "A".repeat(100) + '"';
    const r = scanForSecrets(text);
    expect(r.length).toBe(1);
    expect(r[0].match.length).toBeLessThanOrEqual(65);
    expect(r[0].match.endsWith("…")).toBe(true);
  });
});

describe("formatFindings", () => {
  it("空 findings → 'no secrets detected.'", () => {
    expect(formatFindings([])).toBe("no secrets detected.");
  });

  it("有 finding → 含警告 header + 规则名 + 严重度 + 命中数", () => {
    const r = scanForSecrets(
      "AKIAIOSFODNN7EXAMPLE\nghp_abcdefghijklmnopqrstuvwxyz0123456789"
    );
    const out = formatFindings(r);
    expect(out).toContain("POTENTIAL SECRETS DETECTED");
    expect(out).toContain("2 hits");
    expect(out).toContain("aws-access-key [high]");
    expect(out).toContain("github-token [high]");
  });

  it("同规则多次命中只展示前 3 + 'and N more'", () => {
    const text = Array.from({ length: 5 })
      .map((_, i) => `key${i}=AKIAIOSFODNN7EXAMP${i}1`)
      .join("\n");
    const r = scanForSecrets(text);
    expect(r.length).toBe(5);
    const out = formatFindings(r);
    expect(out).toMatch(/and 2 more/);
  });
});

describe("DEFAULT_RULES 元信息", () => {
  it("每条规则都有名/正则/严重度/描述", () => {
    for (const rule of DEFAULT_RULES) {
      expect(rule.name).toBeTruthy();
      expect(rule.pattern).toBeInstanceOf(RegExp);
      expect(["high", "medium"]).toContain(rule.severity);
      expect(rule.description).toBeTruthy();
    }
  });
});
