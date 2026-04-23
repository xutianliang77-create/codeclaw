import {
  fetchIlinkWechatQrCode,
  finalizeIlinkWechatLogin,
  getIlinkWechatQrStatus,
  type IlinkWechatQrCode,
  type IlinkWechatQrStatus
} from "./auth";
import { loadIlinkWechatCredentials } from "./token";

type FetchLike = typeof fetch;

export interface WechatLoginState {
  phase: "idle" | "waiting" | "scanned" | "confirmed" | "expired" | "error";
  qrcode?: string;
  qrcodeImageContent?: string;
  tokenFile: string;
  baseUrl: string;
  message: string;
  ilinkBotId?: string;
  ilinkUserId?: string;
}

export class IlinkWechatLoginManager {
  private state: WechatLoginState;
  private activePromise: Promise<void> | null = null;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly options: {
      tokenFile: string;
      baseUrl: string;
      fetchImpl?: FetchLike;
      pollIntervalMs?: number;
      maxPollRounds?: number;
      onConfirmed?: (state: WechatLoginState) => void | Promise<void>;
    }
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.state = {
      phase: "idle",
      tokenFile: options.tokenFile,
      baseUrl: options.baseUrl,
      message: "wechat login not started"
    };
  }

  async ensureStarted(): Promise<WechatLoginState> {
    if (!this.activePromise) {
      const qrCode = await this.fetchQrCode();
      if (!qrCode) {
        return this.getState();
      }

      this.activePromise = this.pollLogin(qrCode).finally(() => {
        this.activePromise = null;
      });
    }

    return this.getState();
  }

  async restart(): Promise<WechatLoginState> {
    this.activePromise = null;
    return this.ensureStarted();
  }

  async refreshStatus(): Promise<WechatLoginState> {
    try {
      const credentials = await loadIlinkWechatCredentials(this.options.tokenFile);
      this.state = {
        phase: "confirmed",
        tokenFile: this.options.tokenFile,
        baseUrl: credentials.baseUrl,
        message: "wechat login ready",
        ilinkBotId: credentials.ilinkBotId,
        ilinkUserId: credentials.ilinkUserId
      };
      await this.options.onConfirmed?.(this.getState());
    } catch {
      // ignore missing file and fall back to in-memory status
    }

    return this.getState();
  }

  getState(): WechatLoginState {
    return { ...this.state };
  }

  private async fetchQrCode(): Promise<IlinkWechatQrCode | null> {
    try {
      const qrCode = await fetchIlinkWechatQrCode(this.options.baseUrl, this.fetchImpl);
      this.state = {
        phase: "waiting",
        tokenFile: this.options.tokenFile,
        baseUrl: this.options.baseUrl,
        qrcode: qrCode.qrcode,
        qrcodeImageContent: qrCode.qrcodeImageContent,
        message: "scan the QR code with WeChat to join"
      };
      return qrCode;
    } catch (error) {
      this.state = {
        phase: "error",
        tokenFile: this.options.tokenFile,
        baseUrl: this.options.baseUrl,
        message: error instanceof Error ? error.message : String(error)
      };
      return null;
    }
  }

  private async pollLogin(qrCode: IlinkWechatQrCode): Promise<void> {
    const maxPollRounds = this.options.maxPollRounds ?? 60;
    const pollIntervalMs = this.options.pollIntervalMs ?? 1_000;

    for (let round = 0; round < maxPollRounds; round += 1) {
      let status: IlinkWechatQrStatus;
      try {
        status = await getIlinkWechatQrStatus(this.options.baseUrl, qrCode.qrcode, this.fetchImpl);
      } catch (error) {
        this.state = {
          ...this.state,
          phase: "error",
          message: error instanceof Error ? error.message : String(error)
        };
        return;
      }

      if (status.status === "scanned") {
        this.state = {
          ...this.state,
          phase: "scanned",
          message: "wechat scanned, waiting for confirmation"
        };
      } else if (status.status === "confirmed" && status.botToken) {
        const credentials = await finalizeIlinkWechatLogin({
          tokenFile: this.options.tokenFile,
          baseUrl: this.options.baseUrl,
          qrcode: qrCode.qrcode,
          status
        });
        this.state = {
          phase: "confirmed",
          tokenFile: this.options.tokenFile,
          baseUrl: credentials.baseUrl,
          message: "wechat login confirmed",
          ilinkBotId: credentials.ilinkBotId,
          ilinkUserId: credentials.ilinkUserId
        };
        await this.options.onConfirmed?.(this.getState());
        return;
      } else if (status.status === "expired") {
        this.state = {
          ...this.state,
          phase: "expired",
          message: "wechat QR code expired"
        };
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    this.state = {
      ...this.state,
      phase: "expired",
      message: "wechat login timed out"
    };
  }
}
