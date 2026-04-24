import type { WechatInboundMessage, WechatWebhookEvent, WechatWebhookRequest } from "./types";

const USER_MESSAGE_TYPE = 1;
const TEXT_ITEM_TYPE = 1;
const IMAGE_ITEM_TYPE = 2;
const AUDIO_ITEM_TYPE = 3;

type IlinkItem = {
  type?: number;
  text_item?: {
    text?: string;
  };
  image_item?: {
    url?: string;
    image_url?: string;
    file_url?: string;
    file_name?: string;
    mime_type?: string;
    width?: number;
    height?: number;
    size_bytes?: number;
  };
  audio_item?: {
    url?: string;
    audio_url?: string;
    file_url?: string;
    file_name?: string;
    mime_type?: string;
    duration_ms?: number;
    size_bytes?: number;
  };
  voice_item?: {
    url?: string;
    audio_url?: string;
    file_url?: string;
    file_name?: string;
    mime_type?: string;
    duration_ms?: number;
    size_bytes?: number;
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
      image?: {
        url?: string;
        dataUrl?: string;
        mimeType?: string;
        fileName?: string;
        width?: number;
        height?: number;
        sizeBytes?: number;
      };
      audio?: {
        url?: string;
        dataUrl?: string;
        mimeType?: string;
        fileName?: string;
        durationMs?: number;
        sizeBytes?: number;
      };
      voice?: {
        url?: string;
        dataUrl?: string;
        mimeType?: string;
        fileName?: string;
        durationMs?: number;
        sizeBytes?: number;
      };
    };
    image?: {
      url?: string;
      dataUrl?: string;
      mimeType?: string;
      fileName?: string;
      width?: number;
      height?: number;
      sizeBytes?: number;
    };
    audio?: {
      url?: string;
      dataUrl?: string;
      mimeType?: string;
      fileName?: string;
      durationMs?: number;
      sizeBytes?: number;
    };
    voice?: {
      url?: string;
      dataUrl?: string;
      mimeType?: string;
      fileName?: string;
      durationMs?: number;
      sizeBytes?: number;
    };
    image_url?: string;
    imageUrl?: string;
    audio_url?: string;
    audioUrl?: string;
    voice_url?: string;
    voiceUrl?: string;
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

function getProtocolImage(items: IlinkItem[] | undefined): WechatInboundMessage["image"] {
  const imageItem = items?.find((item) => item.type === IMAGE_ITEM_TYPE && item.image_item);
  if (!imageItem?.image_item) {
    return null;
  }

  return {
    url:
      imageItem.image_item.url ??
      imageItem.image_item.image_url ??
      imageItem.image_item.file_url,
    fileName: imageItem.image_item.file_name,
    mimeType: imageItem.image_item.mime_type,
    width: imageItem.image_item.width,
    height: imageItem.image_item.height,
    sizeBytes: imageItem.image_item.size_bytes
  };
}

function getProtocolAudio(items: IlinkItem[] | undefined): WechatInboundMessage["audio"] {
  const audioItem = items?.find((item) => item.type === AUDIO_ITEM_TYPE && (item.audio_item || item.voice_item));
  const payload = audioItem?.audio_item ?? audioItem?.voice_item;
  if (!payload) {
    return null;
  }

  return {
    url: payload.url ?? payload.audio_url ?? payload.file_url,
    fileName: payload.file_name,
    mimeType: payload.mime_type,
    durationMs: payload.duration_ms,
    sizeBytes: payload.size_bytes
  };
}

function getCompatImage(event: IlinkRawMessageEvent): WechatInboundMessage["image"] {
  const image =
    event.message?.image ??
    event.message?.content?.image;

  const directUrl =
    event.message?.image_url ??
    event.message?.imageUrl;

  if (image) {
    return {
      url: image.url,
      dataUrl: image.dataUrl,
      mimeType: image.mimeType,
      fileName: image.fileName,
      width: image.width,
      height: image.height,
      sizeBytes: image.sizeBytes
    };
  }

  if (directUrl) {
    return {
      url: directUrl
    };
  }

  return null;
}

function getCompatAudio(event: IlinkRawMessageEvent): WechatInboundMessage["audio"] {
  const audio =
    event.message?.audio ??
    event.message?.voice ??
    event.message?.content?.audio ??
    event.message?.content?.voice;

  const directUrl =
    event.message?.audio_url ??
    event.message?.audioUrl ??
    event.message?.voice_url ??
    event.message?.voiceUrl;

  if (audio) {
    return {
      url: audio.url,
      dataUrl: audio.dataUrl,
      mimeType: audio.mimeType,
      fileName: audio.fileName,
      durationMs: audio.durationMs,
      sizeBytes: audio.sizeBytes
    };
  }

  if (directUrl) {
    return {
      url: directUrl
    };
  }

  return null;
}

function normalizeProtocolMessage(message: IlinkProtocolMessage): WechatWebhookEvent | null {
  if (message.message_type !== USER_MESSAGE_TYPE) {
    return null;
  }

  const senderId = message.from_user_id?.trim();
  const text = getProtocolText(message.item_list);
  const image = getProtocolImage(message.item_list);
  const audio = getProtocolAudio(message.item_list);
  if (!senderId || (!text.trim() && !image && !audio)) {
    return null;
  }

  const normalized: WechatInboundMessage = {
    messageId: message.client_id?.trim() || `${senderId}-${Date.now()}`,
    senderId,
    chatId: senderId,
    chatType: "direct",
    text,
    contextToken: message.context_token ?? null,
    image,
    audio
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
  const image = getCompatImage(event);
  const audio = getCompatAudio(event);

  if (!messageId || !senderId || !chatId || (!text.trim() && !image && !audio)) {
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
    mentionSelf: event.mention_self ?? false,
    image,
    audio
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
