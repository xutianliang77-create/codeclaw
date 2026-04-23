import { saveIlinkWechatCredentials, type IlinkWechatLoginResult } from "./token";

type FetchLike = typeof fetch;

function joinUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
}

function createWechatUin(): string {
  return Buffer.from(String(Math.floor(Math.random() * 0xffffffff)), "utf8").toString("base64");
}

function buildHeaders(token?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": createWechatUin(),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

export interface IlinkWechatQrCode {
  qrcode: string;
  qrcodeImageContent?: string;
}

export interface IlinkWechatQrStatus {
  status: "waiting" | "scanned" | "confirmed" | "expired" | "unknown";
  botToken?: string;
  ilinkBotId?: string;
  ilinkUserId?: string;
}

function normalizeQrStatus(value: unknown): IlinkWechatQrStatus["status"] {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "0" || text === "waiting") {
    return "waiting";
  }
  if (text === "1" || text === "scanned") {
    return "scanned";
  }
  if (text === "2" || text === "confirmed" || text === "success") {
    return "confirmed";
  }
  if (text === "3" || text === "expired" || text === "timeout") {
    return "expired";
  }

  return "unknown";
}

export async function fetchIlinkWechatQrCode(
  baseUrl: string,
  fetchImpl: FetchLike = fetch
): Promise<IlinkWechatQrCode> {
  const response = await fetchImpl(joinUrl(baseUrl, "ilink/bot/get_bot_qrcode?bot_type=3"), {
    method: "GET",
    headers: buildHeaders()
  });

  if (!response.ok) {
    throw new Error(`iLink get_bot_qrcode failed: ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const data = (payload.data ?? payload.resp ?? payload) as Record<string, unknown>;
  const qrcode = String(data.qrcode ?? "");

  if (!qrcode) {
    throw new Error("iLink get_bot_qrcode returned no qrcode");
  }

  return {
    qrcode,
    qrcodeImageContent:
      typeof data.qrcode_img_content === "string" ? data.qrcode_img_content : undefined
  };
}

export async function getIlinkWechatQrStatus(
  baseUrl: string,
  qrcode: string,
  fetchImpl: FetchLike = fetch
): Promise<IlinkWechatQrStatus> {
  const response = await fetchImpl(
    joinUrl(baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`),
    {
      method: "GET",
      headers: buildHeaders()
    }
  );

  if (!response.ok) {
    throw new Error(`iLink get_qrcode_status failed: ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const data = (payload.data ?? payload.resp ?? payload) as Record<string, unknown>;

  return {
    status: normalizeQrStatus(data.status ?? data.qrcode_status),
    botToken:
      typeof data.bot_token === "string"
        ? data.bot_token
        : typeof data.token === "string"
          ? data.token
          : undefined,
    ilinkBotId:
      typeof data.ilink_bot_id === "string"
        ? data.ilink_bot_id
        : typeof data.bot_id === "string"
          ? data.bot_id
          : undefined,
    ilinkUserId:
      typeof data.ilink_user_id === "string"
        ? data.ilink_user_id
        : typeof data.user_id === "string"
          ? data.user_id
          : undefined
  };
}

export async function finalizeIlinkWechatLogin(options: {
  tokenFile: string;
  baseUrl: string;
  qrcode: string;
  status: IlinkWechatQrStatus;
}): Promise<IlinkWechatLoginResult> {
  if (options.status.status !== "confirmed" || !options.status.botToken) {
    throw new Error("iLink QR code is not confirmed yet");
  }

  const credentials: IlinkWechatLoginResult = {
    token: options.status.botToken,
    baseUrl: options.baseUrl,
    ilinkBotId: options.status.ilinkBotId,
    ilinkUserId: options.status.ilinkUserId,
    qrcode: options.qrcode
  };

  await saveIlinkWechatCredentials(options.tokenFile, credentials);
  return credentials;
}
