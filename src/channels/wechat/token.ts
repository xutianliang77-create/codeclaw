import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

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

export async function loadIlinkWechatCredentials(tokenFile: string): Promise<IlinkWechatCredentials> {
  const resolvedFile = resolveIlinkWechatTokenFile(tokenFile);
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
  const resolvedFile = resolveIlinkWechatTokenFile(tokenFile);
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
