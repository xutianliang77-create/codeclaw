import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";

/** 旧版 scaffold 的默认 tokenFile 位置（沿用自 Claude Code），仅用于自动迁移探测 */
const LEGACY_DEFAULT_PATH = "~/.claude/wechat-ibot/default.json";

/** P0-W1-09 起的新默认 tokenFile 位置（与 ~/.codeclaw/ 对齐） */
const CURRENT_DEFAULT_PATH = "~/.codeclaw/wechat-ibot/default.json";

export interface IlinkWechatCredentials {
  token: string;
  baseUrl: string;
  ilinkBotId?: string;
  ilinkUserId?: string;
}

export interface IlinkWechatLoginResult extends IlinkWechatCredentials {
  qrcode?: string;
}

function expandHomePath(filePath: string): string {
  if (!filePath.startsWith("~/")) {
    return filePath;
  }

  return path.join(homedir(), filePath.slice(2));
}

function extractString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

export function resolveIlinkWechatTokenFile(tokenFile: string): string {
  return expandHomePath(tokenFile);
}

/**
 * P0-W1-09 · 登录凭证文件的路径迁移 + 权限守卫
 *
 * 动作（按顺序）：
 *   1. 展开 `tokenFile` 中的 `~`
 *   2. 若 `tokenFile` 指向新默认路径 `~/.codeclaw/wechat-ibot/default.json`，
 *      且新路径不存在但旧路径 `~/.claude/wechat-ibot/default.json` 存在：
 *        - 复制旧文件到新路径
 *        - chmod 600
 *        - 删除旧文件（完成一次性迁移）
 *   3. 若目标文件存在且 POSIX 权限宽于 0600，尝试 chmod 600；失败则抛错
 *   4. Windows 下跳过权限检查（NTFS 不映射 POSIX mode）
 *
 * 使用时机：load / save 之前调一次；幂等；可重复调用不产生副作用。
 *
 * 关联：v4.2 §9.1 tokenFile 说明、附录 E T11 会话劫持（Bot Token）缓解
 */
export function ensureIlinkWechatTokenFile(tokenFile: string): string {
  const resolved = resolveIlinkWechatTokenFile(tokenFile);
  const resolvedLegacy = resolveIlinkWechatTokenFile(LEGACY_DEFAULT_PATH);
  const resolvedCurrentDefault = resolveIlinkWechatTokenFile(CURRENT_DEFAULT_PATH);

  // (1) 旧路径 → 新路径一次性迁移（仅对"默认新路径"触发，不碰用户自定义路径）
  if (resolved === resolvedCurrentDefault && !existsSync(resolved)) {
    if (existsSync(resolvedLegacy)) {
      try {
        mkdirSync(path.dirname(resolved), { recursive: true });
        copyFileSync(resolvedLegacy, resolved);
        if (!isWindows()) chmodSync(resolved, 0o600);
        unlinkSync(resolvedLegacy);
      } catch (err) {
        // 迁移失败不致命；下一次启动会重试。但要抛给调用方，避免用户误以为已迁完。
        throw new Error(
          `Failed to migrate legacy tokenFile from ${resolvedLegacy} to ${resolved}: ${(err as Error).message}`
        );
      }
    }
  }

  // (2) 权限守卫（Windows 跳过）
  if (existsSync(resolved) && !isWindows()) {
    const stat = statSync(resolved);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      try {
        chmodSync(resolved, 0o600);
      } catch (err) {
        throw new Error(
          `tokenFile ${resolved} permission 0o${mode.toString(8)} is wider than 0o600 and chmod failed: ${(err as Error).message}`
        );
      }
    }
  }

  return resolved;
}

function isWindows(): boolean {
  return platform() === "win32";
}

export async function loadIlinkWechatCredentials(tokenFile: string): Promise<IlinkWechatCredentials> {
  const resolvedFile = ensureIlinkWechatTokenFile(tokenFile);
  const parsed = JSON.parse(await readFile(resolvedFile, "utf8")) as Record<string, unknown>;
  const auth = (parsed.auth ?? {}) as Record<string, unknown>;

  const token =
    extractString(parsed, ["bot_token", "token", "access_token", "accessToken"]) ??
    extractString(auth, ["bot_token", "token", "access_token", "accessToken"]);

  if (!token) {
    throw new Error(`iLink token file missing bot token: ${resolvedFile}`);
  }

  const baseUrl =
    extractString(parsed, ["baseurl", "baseUrl", "base_url", "apiBaseUrl", "api_base_url"]) ??
    extractString(auth, ["baseurl", "baseUrl", "base_url", "apiBaseUrl", "api_base_url"]) ??
    process.env.CODECLAW_ILINK_WECHAT_BASE_URL ??
    "https://ilinkai.weixin.qq.com";

  return {
    token,
    baseUrl,
    ilinkBotId:
      extractString(parsed, ["ilink_bot_id", "bot_id", "botId"]) ??
      extractString(auth, ["ilink_bot_id", "bot_id", "botId"]),
    ilinkUserId:
      extractString(parsed, ["ilink_user_id", "user_id", "userId"]) ??
      extractString(auth, ["ilink_user_id", "user_id", "userId"])
  };
}

export async function saveIlinkWechatCredentials(
  tokenFile: string,
  credentials: IlinkWechatLoginResult
): Promise<void> {
  // save 前先触发一次迁移 + 权限守卫；保证存档位置一致
  const resolvedFile = ensureIlinkWechatTokenFile(tokenFile);
  await mkdir(path.dirname(resolvedFile), { recursive: true });
  await writeFile(
    resolvedFile,
    JSON.stringify(
      {
        bot_token: credentials.token,
        baseurl: credentials.baseUrl,
        ilink_bot_id: credentials.ilinkBotId,
        ilink_user_id: credentials.ilinkUserId,
        qrcode: credentials.qrcode
      },
      null,
      2
    ),
    {
      encoding: "utf8",
      mode: 0o600
    }
  );
}
