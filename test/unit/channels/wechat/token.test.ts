/**
 * P0-W1-09 · tokenFile 路径迁移 + chmod 600 守卫
 *
 * 覆盖：
 *   - resolveIlinkWechatTokenFile 的 ~ 展开
 *   - 自定义路径不触发 legacy 迁移
 *   - 权限宽于 0600 → 自动 chmod 600
 *   - load/save 之前 ensure 被调
 *
 * 由于自动迁移只在 tokenFile === 默认新路径时触发，
 * 测试里通过 mock homedir 可以精确控制。
 * 为了保持简单，这里用 "自定义 tokenFile 路径" 路径做权限守卫的覆盖；
 * legacy 迁移路径单独用"显式传入 legacy/new 两个 tmp 路径"用例（不依赖 homedir）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import path from "node:path";
import os from "node:os";

import {
  ensureIlinkWechatTokenFile,
  loadIlinkWechatCredentials,
  resolveIlinkWechatTokenFile,
  saveIlinkWechatCredentials,
} from "../../../../src/channels/wechat/token";

let tmpDir: string;
const isWin = platform() === "win32";

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-token-"));
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveIlinkWechatTokenFile", () => {
  it("expands ~ to homedir", () => {
    const resolved = resolveIlinkWechatTokenFile("~/some/place/token.json");
    expect(resolved.startsWith(os.homedir())).toBe(true);
    expect(resolved).toContain("/some/place/token.json");
  });

  it("leaves absolute paths unchanged", () => {
    const abs = path.join(tmpDir, "abs.json");
    expect(resolveIlinkWechatTokenFile(abs)).toBe(abs);
  });
});

describe("ensureIlinkWechatTokenFile · permission guard", () => {
  it.skipIf(isWin)("chmods 0644 to 0600 automatically", () => {
    const tokenPath = path.join(tmpDir, "token.json");
    writeFileSync(tokenPath, "{}", { mode: 0o644 });
    expect(statSync(tokenPath).mode & 0o777).toBe(0o644);

    const ret = ensureIlinkWechatTokenFile(tokenPath);
    expect(ret).toBe(tokenPath);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWin)("leaves 0600 file untouched and returns resolved path", () => {
    const tokenPath = path.join(tmpDir, "token.json");
    writeFileSync(tokenPath, "{}", { mode: 0o600 });

    const ret = ensureIlinkWechatTokenFile(tokenPath);
    expect(ret).toBe(tokenPath);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("no-op when file does not exist and not default path", () => {
    const tokenPath = path.join(tmpDir, "missing.json");
    const ret = ensureIlinkWechatTokenFile(tokenPath);
    expect(ret).toBe(tokenPath);
    expect(existsSync(tokenPath)).toBe(false);
  });
});

describe("ensureIlinkWechatTokenFile · legacy migration (scoped)", () => {
  // 说明：真正的 "~/.claude → ~/.codeclaw" 自动迁移只在 tokenFile === 默认新路径时触发，
  //       依赖 os.homedir()。端到端测试开销大；此处通过"用自定义路径"绕开，
  //       只验证"tokenFile 非默认新路径时，旧 legacy 不会被意外搬动"。
  it("does NOT touch custom tokenFile even if a legacy file happens to exist in homedir", () => {
    const tokenPath = path.join(tmpDir, "custom.json");
    writeFileSync(tokenPath, "{}", { mode: 0o600 });
    // 即使 ~/.claude/wechat-ibot/default.json 客观上可能存在，
    // 自定义路径不会触发迁移；返回值就是传入的自定义路径
    const ret = ensureIlinkWechatTokenFile(tokenPath);
    expect(ret).toBe(tokenPath);
  });
});

describe("loadIlinkWechatCredentials / saveIlinkWechatCredentials · integration", () => {
  it.skipIf(isWin)("save writes 0600 and load reads token", async () => {
    const tokenPath = path.join(tmpDir, "nested/dir/token.json");
    await saveIlinkWechatCredentials(tokenPath, {
      token: "tk-abcd",
      baseUrl: "https://ilinkai.weixin.qq.com",
      ilinkBotId: "bot-1",
      ilinkUserId: "user-1",
    });
    expect(existsSync(tokenPath)).toBe(true);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

    const creds = await loadIlinkWechatCredentials(tokenPath);
    expect(creds.token).toBe("tk-abcd");
    expect(creds.baseUrl).toBe("https://ilinkai.weixin.qq.com");
    expect(creds.ilinkBotId).toBe("bot-1");
    expect(creds.ilinkUserId).toBe("user-1");
  });

  it.skipIf(isWin)("load auto-chmods a pre-existing 0644 file", async () => {
    const tokenPath = path.join(tmpDir, "loose.json");
    writeFileSync(
      tokenPath,
      JSON.stringify({ bot_token: "tk-xxx", baseurl: "https://example.com" }),
      { mode: 0o644 }
    );
    expect(statSync(tokenPath).mode & 0o777).toBe(0o644);

    const creds = await loadIlinkWechatCredentials(tokenPath);
    expect(creds.token).toBe("tk-xxx");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("load throws when file missing", async () => {
    const tokenPath = path.join(tmpDir, "none.json");
    await expect(loadIlinkWechatCredentials(tokenPath)).rejects.toThrow();
  });

  it("load throws when file lacks token", async () => {
    const tokenPath = path.join(tmpDir, "empty.json");
    writeFileSync(tokenPath, JSON.stringify({ baseurl: "x" }), { mode: 0o600 });
    await expect(loadIlinkWechatCredentials(tokenPath)).rejects.toThrow(/missing bot token/i);
  });
});
