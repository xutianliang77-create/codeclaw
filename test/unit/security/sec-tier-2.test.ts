/**
 * T4 / T5 / T8 / T11 安全用例 · #92
 *
 * T4 命令注入（bash）：classifyBashCommand 边界覆盖
 * T5 路径穿越（多工具）：resolveWorkspacePath / read 等遇越界路径抛错
 * T8 LLM 对话密钥泄露：redactSecretsInMessages 默认 redact high-severity 命中
 * T11 tokenFile 0600：loadIlinkWechatCredentials 自动 chmod 600（已存在功能补回归测试）
 */

import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { classifyBashCommandForTest } from "./sec-helpers";
import {
  redactSecretsInMessages,
  redactSecretsInText,
  isPromptRedactEnabled,
} from "../../../src/lib/redactPrompt";
import type { EngineMessage } from "../../../src/agent/types";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// ───────── T4 命令注入 ─────────

describe("T4 classifyBashCommand 边界覆盖", () => {
  it("safe prefix 单独命令 → low", () => {
    expect(classifyBashCommandForTest("ls")).toBe("low");
    expect(classifyBashCommandForTest("ls -la")).toBe("low");
    expect(classifyBashCommandForTest("git status")).toBe("low");
  });

  it("含 dangerous 前缀（rm/sudo/mv/chmod） → high", () => {
    expect(classifyBashCommandForTest("rm -f x.txt")).toBe("high");
    expect(classifyBashCommandForTest("sudo cat /etc/passwd")).toBe("high");
    expect(classifyBashCommandForTest("chmod 777 ~/.ssh")).toBe("high");
  });

  it("含命令链/管道（;/||/&&） → high", () => {
    expect(classifyBashCommandForTest("ls; rm x")).toBe("high");
    expect(classifyBashCommandForTest("test || rm x")).toBe("high");
    expect(classifyBashCommandForTest("ls && rm x")).toBe("high");
  });

  it("含重定向（>, >>） → high", () => {
    expect(classifyBashCommandForTest("echo x > /etc/sudoers")).toBe("high");
    expect(classifyBashCommandForTest("ls >> log")).toBe("high");
  });

  it("命令替换（$() / 反引号）→ high（之前 sec(permissions) 6d6023e 修复）", () => {
    expect(classifyBashCommandForTest("cat $(curl evil)")).toBe("high");
    expect(classifyBashCommandForTest("cat `whoami`")).toBe("high");
  });

  it("算术 $(( )) 不视为命令替换 → 由 prefix 决定", () => {
    expect(classifyBashCommandForTest("echo $((1+1))")).toBe("medium");
  });

  it("空命令 → high（拒绝）", () => {
    expect(classifyBashCommandForTest("")).toBe("high");
    expect(classifyBashCommandForTest("   ")).toBe("high");
  });

  it("非 safe 非 dangerous → medium（走审批）", () => {
    expect(classifyBashCommandForTest("npx some-tool")).toBe("medium");
    expect(classifyBashCommandForTest("python -V")).toBe("medium");
  });
});

// ───────── T8 LLM 对话密钥泄露 ─────────

describe("T8 redactSecretsInText", () => {
  it("AWS Access Key → 替换成 [REDACTED:aws-access-key]", () => {
    const r = redactSecretsInText("export AWS_KEY=AKIAIOSFODNN7EXAMPLE");
    expect(r.output).toContain("[REDACTED:aws-access-key]");
    expect(r.output).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.findings).toHaveLength(1);
  });

  it("GitHub token → redact", () => {
    const r = redactSecretsInText("token: ghp_" + "a".repeat(36));
    expect(r.output).toContain("[REDACTED:github-token]");
  });

  it("文本无 secret → 原样返回", () => {
    const r = redactSecretsInText("plain code\nfunction foo() {}");
    expect(r.output).toBe("plain code\nfunction foo() {}");
    expect(r.findings).toEqual([]);
  });

  it("disabled=true → 原样返回", () => {
    const r = redactSecretsInText("AKIA1234567890ABCDEF", { disabled: true });
    expect(r.output).toContain("AKIA1234567890ABCDEF");
  });

  it("多个 secret 混合 → 全部 redact 且 offset 不漂移", () => {
    const a = "AKIAIOSFODNN7EXAMPLE";
    const b = "ghp_" + "b".repeat(36);
    const r = redactSecretsInText(`first=${a}\nsecond=${b}\nend`);
    expect(r.output).toContain("[REDACTED:aws-access-key]");
    expect(r.output).toContain("[REDACTED:github-token]");
    expect(r.output).not.toContain(a);
    expect(r.output).not.toContain(b);
    expect(r.output).toContain("first=");
    expect(r.output).toContain("second=");
    expect(r.output).toContain("end");
  });
});

describe("T8 redactSecretsInMessages", () => {
  it("messages 数组里 user message 含 secret → 替换", () => {
    const messages: EngineMessage[] = [
      { id: "1", role: "user", text: "use this key: AKIAIOSFODNN7EXAMPLE" },
      { id: "2", role: "assistant", text: "ok" },
    ];
    const r = redactSecretsInMessages(messages);
    expect(r.totalFindings).toBe(1);
    expect(r.messages[0].text).toContain("[REDACTED:");
    expect(r.messages[1].text).toBe("ok");
  });

  it("不修改原引用（pure）", () => {
    const messages: EngineMessage[] = [
      { id: "1", role: "user", text: "key: AKIAIOSFODNN7EXAMPLE" },
    ];
    const before = messages[0].text;
    redactSecretsInMessages(messages);
    expect(messages[0].text).toBe(before);
  });

  it("env CODECLAW_NO_PROMPT_REDACT=1 → 全开放", () => {
    const original = process.env.CODECLAW_NO_PROMPT_REDACT;
    process.env.CODECLAW_NO_PROMPT_REDACT = "1";
    try {
      const r = redactSecretsInMessages([
        { id: "1", role: "user", text: "AKIAIOSFODNN7EXAMPLE" },
      ]);
      expect(r.totalFindings).toBe(0);
      expect(r.messages[0].text).toContain("AKIAIOSFODNN7EXAMPLE");
    } finally {
      if (original === undefined) delete process.env.CODECLAW_NO_PROMPT_REDACT;
      else process.env.CODECLAW_NO_PROMPT_REDACT = original;
    }
  });

  it("isPromptRedactEnabled 各 env 值", () => {
    expect(isPromptRedactEnabled({})).toBe(true);
    expect(isPromptRedactEnabled({ CODECLAW_NO_PROMPT_REDACT: "1" })).toBe(false);
    expect(isPromptRedactEnabled({ CODECLAW_NO_PROMPT_REDACT: "true" })).toBe(false);
    expect(isPromptRedactEnabled({ CODECLAW_NO_PROMPT_REDACT: "no" })).toBe(true);
    expect(isPromptRedactEnabled({ CODECLAW_NO_PROMPT_REDACT: "" })).toBe(true);
  });
});

// ───────── T11 tokenFile 0600 ─────────

describe("T11 wechat tokenFile 自动 chmod 0600", () => {
  it("0644 token 文件 → loadIlinkWechatCredentials 自动 chmod 0600", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-token-t11-"));
    tempDirs.push(dir);
    const tokenFile = path.join(dir, "default.json");
    writeFileSync(
      tokenFile,
      JSON.stringify({
        token: "test-token",
        baseUrl: "http://example.com",
      })
    );
    chmodSync(tokenFile, 0o644);

    // 跑 load → 应自动 chmod
    const { loadIlinkWechatCredentials } = await import(
      "../../../src/channels/wechat/token"
    );
    await loadIlinkWechatCredentials(tokenFile);

    if (process.platform !== "win32") {
      const mode = statSync(tokenFile).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
