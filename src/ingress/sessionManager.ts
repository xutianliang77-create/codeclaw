import type { ChannelType } from "../channels/channelAdapter";

export interface SessionInfo {
  sessionId: string;
  channel: ChannelType;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
}

function buildSessionKey(channel: ChannelType, userId: string): string {
  return `${channel}:${userId}`;
}

export class SessionManager {
  private readonly sessionsByKey = new Map<string, SessionInfo>();

  bind(channel: ChannelType, userId: string, sessionId: string): SessionInfo {
    const key = buildSessionKey(channel, userId);
    const current = this.sessionsByKey.get(key);
    const now = Date.now();

    const next: SessionInfo = current
      ? {
          ...current,
          sessionId,
          lastSeenAt: now
        }
      : {
          sessionId,
          channel,
          userId,
          createdAt: now,
          lastSeenAt: now
        };

    this.sessionsByKey.set(key, next);
    return next;
  }

  resolve(channel: ChannelType, userId: string, fallbackSessionId: string): SessionInfo {
    return this.bind(channel, userId, fallbackSessionId);
  }

  touch(sessionId: string): void {
    for (const [key, value] of this.sessionsByKey.entries()) {
      if (value.sessionId === sessionId) {
        this.sessionsByKey.set(key, {
          ...value,
          lastSeenAt: Date.now()
        });
        return;
      }
    }
  }

  list(): SessionInfo[] {
    return [...this.sessionsByKey.values()];
  }

  destroy(sessionId: string): void {
    for (const [key, value] of this.sessionsByKey.entries()) {
      if (value.sessionId === sessionId) {
        this.sessionsByKey.delete(key);
      }
    }
  }
}
