import type { QueryEngine, QueryEngineOptions } from "../../agent/types";
import type { IngressMessage } from "../channelAdapter";
import { buildWechatMarkdownCard } from "./formatter";
import type { WechatContextMapping, WechatDeliveryCard, WechatInboundMessage, WechatChatType } from "./types";
import { IngressGateway } from "../../ingress/gateway";

interface WechatRuntime {
  userKey: string;
  queryEngine: QueryEngine;
  ingressGateway: IngressGateway;
  lastContext: WechatContextMapping | null;
  lastDeliveredAssistantMessageId: string | null;
  dirty: boolean;
  unsubscribe: (() => void) | null;
}

function normalizeChatType(chatType?: WechatChatType): WechatChatType {
  return chatType === "room" ? "room" : "direct";
}

function createTraceId(): string {
  return `wechat-trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildWechatScopedUserId(message: WechatInboundMessage): string {
  const chatType = normalizeChatType(message.chatType);
  return `wechat:${chatType}:${message.chatId}:${message.senderId}`;
}

export function buildWechatContextMapping(message: WechatInboundMessage): WechatContextMapping {
  return {
    scopedUserId: buildWechatScopedUserId(message),
    contextToken: message.contextToken ?? null,
    chatId: message.chatId,
    chatType: normalizeChatType(message.chatType),
    senderId: message.senderId,
    senderName: message.senderName,
    mentionSelf: message.mentionSelf ?? false
  };
}

export function createWechatIngressMessage(
  message: WechatInboundMessage,
  options: {
    sessionId?: string | null;
  } = {}
): IngressMessage {
  const mapping = buildWechatContextMapping(message);
  const trimmed = message.text.trim();

  return {
    channel: "wechat",
    userId: mapping.scopedUserId,
    sessionId: options.sessionId ?? message.sessionId ?? null,
    input: message.text,
    priority:
      trimmed === "/approve" ||
      trimmed === "/deny" ||
      trimmed === "/resume" ||
      trimmed.startsWith("/approve ") ||
      trimmed.startsWith("/deny ")
        ? "high"
        : "normal",
    timestamp: message.timestamp ?? Date.now(),
    metadata: {
      transport: "rest",
      source: trimmed.startsWith("/") ? "command" : "user",
      channelSpecific: {
        messageId: message.messageId,
        chatId: mapping.chatId,
        chatType: mapping.chatType,
        senderId: mapping.senderId,
        senderName: mapping.senderName,
        mentionSelf: mapping.mentionSelf,
        contextToken: mapping.contextToken
      }
    }
  };
}

export class WechatBotAdapter {
  private readonly runtimesByUserKey = new Map<string, WechatRuntime>();
  private readonly runtimesBySessionId = new Map<string, WechatRuntime>();
  private sharedRuntime: WechatRuntime | null = null;

  constructor(
    private readonly createEngine: () => QueryEngine
  ) {}

  async receiveMessage(message: WechatInboundMessage): Promise<WechatDeliveryCard> {
    const mapping = buildWechatContextMapping(message);
    const runtime = this.resolveRuntime(message);
    const ingressMessage = createWechatIngressMessage(message, {
      sessionId: runtime.queryEngine.getSessionId()
    });

    const envelopes = [];
    for await (const envelope of runtime.ingressGateway.handleMessage(ingressMessage)) {
      envelopes.push(envelope);
    }

    const traceId = envelopes.at(-1)?.traceId ?? createTraceId();
    const snapshot = runtime.queryEngine.getChannelSnapshot();
    const contextToken = snapshot.sessionId;
    const latestAssistantMessage = [...snapshot.messages]
      .reverse()
      .find((entry) => entry.role === "assistant");
    runtime.lastDeliveredAssistantMessageId = latestAssistantMessage?.id ?? runtime.lastDeliveredAssistantMessageId;
    runtime.dirty = false;

    return {
      sessionId: snapshot.sessionId,
      traceId,
      contextToken,
      markdown: buildWechatMarkdownCard({
        snapshot,
        traceId,
        contextToken,
        variant: "message",
        envelopes
      }),
      pendingApproval: Boolean(snapshot.pendingApproval || snapshot.pendingOrchestrationApproval),
      replyTarget: {
        senderId: mapping.senderId,
        senderName: mapping.senderName,
        chatId: mapping.chatId,
        chatType: mapping.chatType
      }
    };
  }

  buildApprovalNotificationCard(contextToken: string): WechatDeliveryCard | null {
    const runtime = this.runtimesBySessionId.get(contextToken);
    if (!runtime) {
      return null;
    }

    const snapshot = runtime.queryEngine.getChannelSnapshot();
    if (!snapshot.pendingApproval && !snapshot.pendingOrchestrationApproval) {
      return null;
    }

    const traceId = createTraceId();
    return {
      sessionId: snapshot.sessionId,
      traceId,
      contextToken: snapshot.sessionId,
      markdown: buildWechatMarkdownCard({
        snapshot,
        traceId,
        contextToken: snapshot.sessionId,
        variant: "approval-notify"
      }),
      pendingApproval: true,
      replyTarget: runtime.lastContext
        ? {
            senderId: runtime.lastContext.senderId,
            senderName: runtime.lastContext.senderName,
            chatId: runtime.lastContext.chatId,
            chatType: runtime.lastContext.chatType
          }
        : undefined
    };
  }

  buildResumeCard(contextToken: string): WechatDeliveryCard | null {
    const runtime = this.runtimesBySessionId.get(contextToken);
    if (!runtime) {
      return null;
    }

    const snapshot = runtime.queryEngine.getChannelSnapshot();
    const traceId = createTraceId();

    return {
      sessionId: snapshot.sessionId,
      traceId,
      contextToken: snapshot.sessionId,
      markdown: buildWechatMarkdownCard({
        snapshot,
        traceId,
        contextToken: snapshot.sessionId,
        variant: "resume"
      }),
      pendingApproval: Boolean(snapshot.pendingApproval || snapshot.pendingOrchestrationApproval),
      replyTarget: runtime.lastContext
        ? {
            senderId: runtime.lastContext.senderId,
            senderName: runtime.lastContext.senderName,
            chatId: runtime.lastContext.chatId,
            chatType: runtime.lastContext.chatType
          }
        : undefined
    };
  }

  buildPendingApprovalCards(): WechatDeliveryCard[] {
    const cards: WechatDeliveryCard[] = [];

    for (const [sessionId, runtime] of this.runtimesBySessionId.entries()) {
      const snapshot = runtime.queryEngine.getChannelSnapshot();
      if (!snapshot.pendingApproval && !snapshot.pendingOrchestrationApproval) {
        continue;
      }

      const traceId = createTraceId();
      cards.push({
        sessionId: snapshot.sessionId,
        traceId,
        contextToken: sessionId,
        markdown: buildWechatMarkdownCard({
          snapshot,
          traceId,
          contextToken: sessionId,
          variant: "approval-notify"
        }),
        pendingApproval: true,
        replyTarget: runtime.lastContext
          ? {
              senderId: runtime.lastContext.senderId,
              senderName: runtime.lastContext.senderName,
              chatId: runtime.lastContext.chatId,
              chatType: runtime.lastContext.chatType
            }
          : undefined
      });
    }

    return cards;
  }

  buildSessionUpdateCards(): WechatDeliveryCard[] {
    const cards: WechatDeliveryCard[] = [];

    for (const runtime of new Set(this.runtimesBySessionId.values())) {
      if (!runtime.dirty || !runtime.lastContext) {
        continue;
      }

      const snapshot = runtime.queryEngine.getChannelSnapshot();
      const latestAssistantMessage = [...snapshot.messages]
        .reverse()
        .find((message) => message.role === "assistant");

      if (!latestAssistantMessage || latestAssistantMessage.id === runtime.lastDeliveredAssistantMessageId) {
        runtime.dirty = false;
        continue;
      }

      const traceId = createTraceId();
      cards.push({
        sessionId: snapshot.sessionId,
        traceId,
        contextToken: snapshot.sessionId,
        markdown: buildWechatMarkdownCard({
          snapshot,
          traceId,
          contextToken: snapshot.sessionId,
          variant: "session-sync"
        }),
        pendingApproval: Boolean(snapshot.pendingApproval || snapshot.pendingOrchestrationApproval),
        replyTarget: {
          senderId: runtime.lastContext.senderId,
          senderName: runtime.lastContext.senderName,
          chatId: runtime.lastContext.chatId,
          chatType: runtime.lastContext.chatType
        }
      });
      runtime.lastDeliveredAssistantMessageId = latestAssistantMessage.id;
      runtime.dirty = false;
    }

    return cards;
  }

  getActiveSessions(): Array<{ userKey: string; sessionId: string }> {
    return [...new Set(this.runtimesBySessionId.values())].map((runtime) => ({
      userKey: runtime.userKey,
      sessionId: runtime.queryEngine.getSessionId()
    }));
  }

  attachSharedRuntime(queryEngine: QueryEngine): void {
    const sessionId = queryEngine.getSessionId();
    const existing = this.runtimesBySessionId.get(sessionId) ?? this.sharedRuntime;

    if (existing && existing.queryEngine === queryEngine) {
      this.sharedRuntime = existing;
      return;
    }

    if (this.sharedRuntime) {
      this.deleteRuntimeMappings(this.sharedRuntime);
    }

    const runtime: WechatRuntime = {
      userKey: "__shared__",
      queryEngine,
      ingressGateway: new IngressGateway(queryEngine),
      lastContext: existing?.lastContext ?? null,
      lastDeliveredAssistantMessageId: existing?.lastDeliveredAssistantMessageId ?? null,
      dirty: false,
      unsubscribe: null
    };

    this.registerRuntime(runtime);
    this.sharedRuntime = runtime;
    this.runtimesBySessionId.set(sessionId, runtime);
  }

  private resolveRuntime(message: WechatInboundMessage): WechatRuntime {
    const mapping = buildWechatContextMapping(message);
    if (this.sharedRuntime) {
      const previousUserRuntime = this.runtimesByUserKey.get(mapping.scopedUserId);
      if (previousUserRuntime && previousUserRuntime !== this.sharedRuntime) {
        this.deleteRuntimeMappings(previousUserRuntime);
      }

      this.sharedRuntime.userKey = mapping.scopedUserId;
      this.sharedRuntime.lastContext = mapping;
      this.runtimesByUserKey.set(mapping.scopedUserId, this.sharedRuntime);
      this.runtimesBySessionId.set(this.sharedRuntime.queryEngine.getSessionId(), this.sharedRuntime);
      return this.sharedRuntime;
    }

    const contextRuntime =
      mapping.contextToken && this.runtimesBySessionId.get(mapping.contextToken)
        ? this.runtimesBySessionId.get(mapping.contextToken)
        : null;
    if (contextRuntime) {
      contextRuntime.lastContext = mapping;
      this.runtimesByUserKey.set(mapping.scopedUserId, contextRuntime);
      return contextRuntime;
    }

    const existingRuntime = this.runtimesByUserKey.get(mapping.scopedUserId);
    if (existingRuntime) {
      existingRuntime.lastContext = mapping;
      return existingRuntime;
    }

    const queryEngine = this.createEngine();
    const runtime: WechatRuntime = {
      userKey: mapping.scopedUserId,
      queryEngine,
      ingressGateway: new IngressGateway(queryEngine),
      lastContext: mapping,
      lastDeliveredAssistantMessageId: null,
      dirty: false,
      unsubscribe: null
    };

    this.registerRuntime(runtime);
    this.runtimesByUserKey.set(mapping.scopedUserId, runtime);
    this.runtimesBySessionId.set(queryEngine.getSessionId(), runtime);
    return runtime;
  }

  private deleteRuntimeMappings(target: WechatRuntime): void {
    target.unsubscribe?.();
    target.unsubscribe = null;

    for (const [userKey, runtime] of this.runtimesByUserKey.entries()) {
      if (runtime === target) {
        this.runtimesByUserKey.delete(userKey);
      }
    }

    for (const [sessionId, runtime] of this.runtimesBySessionId.entries()) {
      if (runtime === target) {
        this.runtimesBySessionId.delete(sessionId);
      }
    }
  }

  private registerRuntime(runtime: WechatRuntime): void {
    runtime.unsubscribe?.();
    runtime.unsubscribe = runtime.queryEngine.subscribe(() => {
      const snapshot = runtime.queryEngine.getChannelSnapshot();
      const latestAssistantMessage = [...snapshot.messages]
        .reverse()
        .find((message) => message.role === "assistant");

      if (!latestAssistantMessage) {
        return;
      }

      if (latestAssistantMessage.id !== runtime.lastDeliveredAssistantMessageId) {
        runtime.dirty = true;
      }
    });
  }
}

export function createWechatBotAdapter(options: {
  createQueryEngine: (overrides?: Partial<QueryEngineOptions>) => QueryEngine;
  defaultEngineOptions?: Partial<QueryEngineOptions>;
}): WechatBotAdapter {
  return new WechatBotAdapter(() =>
    options.createQueryEngine({
      ...options.defaultEngineOptions
    })
  );
}
