/**
 * codeclaw-web fetch 客户端（B.2）
 *
 * - 统一 Bearer 注入（zustand auth store）
 * - 统一错误形（{error:{code,message}}）
 * - JSON-only；不处理 form / multipart（M3 attachments 走 messages 端点）
 */

import { useAuthStore } from "@/store/auth";

export interface ApiError extends Error {
  status: number;
  code?: string;
}

function makeApiError(status: number, code: string | undefined, message: string): ApiError {
  const err = new Error(message) as ApiError;
  err.status = status;
  if (code) err.code = code;
  return err;
}

export async function api<T = unknown>(
  method: "GET" | "POST" | "DELETE" | "PATCH" | "PUT",
  path: string,
  body?: unknown
): Promise<T> {
  const token = useAuthStore.getState().token;
  if (!token) {
    throw makeApiError(401, "missing-token", "Not connected; set token first");
  }
  const r = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!r.ok) {
    const err = (json as { error?: { code?: string; message?: string } })?.error;
    throw makeApiError(r.status, err?.code, err?.message ?? `HTTP ${r.status}`);
  }
  return json as T;
}

/** 创建 SSE 订阅（不可加 Authorization 头 → ?token= 在 server 适配前先用 polling 替代） */
export function openEventSource(path: string): EventSource {
  // EventSource 不支持自定义 header；阶段 A 后端已校验 cookie 缺失返 401
  // 阶段 B 后端 GET /v1/web/stream 需要支持 ?token=；当前先尝试用 path 直连
  return new EventSource(path);
}
