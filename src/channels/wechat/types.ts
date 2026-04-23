import type { DeliveryEnvelope } from "../channelAdapter";
import type { ChannelSessionSnapshot, EngineEvent } from "../../agent/types";

export type WechatChatType = "direct" | "room";

export interface WechatInboundMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  chatType?: WechatChatType;
  text: string;
  timestamp?: number;
  contextToken?: string | null;
  sessionId?: string | null;
  mentionSelf?: boolean;
}

export interface WechatContextMapping {
  scopedUserId: string;
  contextToken: string | null;
  chatId: string;
  chatType: WechatChatType;
  senderId: string;
  senderName?: string;
  mentionSelf: boolean;
}

export interface WechatDeliveryCard {
  sessionId: string;
  traceId: string;
  contextToken: string;
  markdown: string;
  pendingApproval: boolean;
  replyTarget?: {
    senderId: string;
    senderName?: string;
    chatId: string;
    chatType: WechatChatType;
  };
}

export interface WechatCardRenderInput {
  snapshot: ChannelSessionSnapshot;
  traceId: string;
  contextToken: string;
  variant: "message" | "approval-notify" | "resume" | "session-sync";
  envelopes?: Array<DeliveryEnvelope<EngineEvent>>;
}

export type WechatWebhookEvent =
  | {
      type: "message";
      message: WechatInboundMessage;
    }
  | {
      type: "resume";
      contextToken: string;
    }
  | {
      type: "approval-notify";
      contextToken: string;
    };

export interface WechatWebhookRequest {
  events: WechatWebhookEvent[];
}

export interface WechatWebhookResponse {
  ok: true;
  cards: WechatDeliveryCard[];
  dropped: number;
}
