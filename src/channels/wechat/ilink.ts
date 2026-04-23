import type { WechatInboundMessage, WechatWebhookEvent, WechatWebhookRequest } from "./types";

const USER_MESSAGE_TYPE = 1;
const TEXT_ITEM_TYPE = 1;

type IlinkItem = {
  type?: number;
  text_item?: {
    text?: string;
  };
};

type IlinkProtocolMessage = {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  message_type?: number;
  context_token?: string;
  item_list?: IlinkItem[];
};

type IlinkRawMessageEvent = {
  type?: string;
  event?: string;
  message?: {
    id?: string;
    message_id?: string;
    text?: string;
    content?: {
      text?: string;
    };
    senderId?: string;
    senderName?: string;
    chatId?: string;
    chatType?: string;
    contextToken?: string;
  };
  sender?: {
    id?: string;
    name?: string;
  };
  from?: {
    id?: string;
    name?: string;
  };
  chat?: {
    id?: string;
    type?: "direct" | "room" | "private" | "group";
  };
  room?: {
    id?: string;
  };
  context_token?: string | null;
  session_id?: string | null;
  mention_self?: boolean;
};

type IlinkResumeEvent = {
  type?: string;
  event?: string;
  context_token?: string;
};

type IlinkWebhookPayload =
  | {
      events?: Array<IlinkRawMessageEvent | IlinkResumeEvent>;
      msgs?: IlinkProtocolMessage[];
      get_updates_buf?: string;
    }
  | IlinkRawMessageEvent;

function normalizeChatType(value: unknown): "direct" | "room" {
  return value === "room" || value === "group" ? "room" : "direct";
}

function normalizeEventType(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
}

function getProtocolText(items: IlinkItem[] | undefined): string {
  return (
    items
      ?.filter((item) => item.type === TEXT_ITEM_TYPE)
      .map((item) => item.text_item?.text ?? "")
      .filter(Boolean)
      .join("\n") ?? ""
  );
}

function normalizeProtocolMessage(message: IlinkProtocolMessage): WechatWebhookEvent | null {
  if (message.message_type !== USER_MESSAGE_TYPE) {
    return null;
  }

  const senderId = message.from_user_id?.trim();
  const text = getProtocolText(message.item_list);
  if (!senderId || !text.trim()) {
    return null;
  }

  const normalized: WechatInboundMessage = {
    messageId: message.client_id?.trim() || `${senderId}-${Date.now()}`,
    senderId,
    chatId: senderId,
    chatType: "direct",
    text,
    contextToken: message.context_token ?? null
  };

  return {
    type: "message",
    message: normalized
  };
}

function normalizeCompatMessageEvent(event: IlinkRawMessageEvent): WechatWebhookEvent | null {
  const text =
    event.message?.text ??
    event.message?.content?.text ??
    "";
  const messageId = event.message?.id ?? event.message?.message_id;
  const senderId = event.sender?.id ?? event.from?.id ?? event.message?.senderId;
  const senderName = event.sender?.name ?? event.from?.name ?? event.message?.senderName;
  const chatId = event.chat?.id ?? event.room?.id ?? event.message?.chatId ?? senderId;
  const chatType = event.chat?.type ?? event.message?.chatType;

  if (!messageId || !senderId || !chatId || !text.trim()) {
    return null;
  }

  const normalized: WechatInboundMessage = {
    messageId,
    senderId,
    senderName,
    chatId,
    chatType: normalizeChatType(chatType),
    text,
    contextToken: event.context_token ?? event.message?.contextToken ?? null,
    sessionId: event.session_id ?? null,
    mentionSelf: event.mention_self ?? false
  };

  return {
    type: "message",
    message: normalized
  };
}

export function normalizeIlinkWebhookPayload(payload: IlinkWebhookPayload): WechatWebhookRequest {
  const events: WechatWebhookEvent[] = [];

  if ("msgs" in payload && Array.isArray(payload.msgs)) {
    for (const message of payload.msgs) {
      const normalized = normalizeProtocolMessage(message);
      if (normalized) {
        events.push(normalized);
      }
    }
    return { events };
  }

  const rawEvents =
    "events" in payload && Array.isArray(payload.events)
      ? payload.events
      : [payload as IlinkRawMessageEvent | IlinkResumeEvent];

  for (const rawEvent of rawEvents) {
    const eventType = normalizeEventType(
      "event" in rawEvent && rawEvent.event !== undefined ? rawEvent.event : rawEvent.type
    );

    if (eventType === "resume") {
      if (rawEvent.context_token) {
        events.push({
          type: "resume",
          contextToken: rawEvent.context_token
        });
      }
      continue;
    }

    if (eventType === "approval-notify" || eventType === "approval-notification") {
      if (rawEvent.context_token) {
        events.push({
          type: "approval-notify",
          contextToken: rawEvent.context_token
        });
      }
      continue;
    }

    if (eventType === "message" || eventType === "chat-message" || eventType === "incoming-message" || eventType === "") {
      const normalized = normalizeCompatMessageEvent(rawEvent as IlinkRawMessageEvent);
      if (normalized) {
        events.push(normalized);
      }
    }
  }

  return { events };
}
