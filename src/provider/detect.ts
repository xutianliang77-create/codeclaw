/**
 * Provider 自动探测（v0.7.0 P2.2）
 *
 * 用途：setup wizard 启动时探测本机 / env 中已就绪的 provider，预填表单。
 *
 * 探测范围：
 *   - 本地 HTTP：LM Studio (localhost:1234) / Ollama (localhost:11434)，500ms 超时
 *   - 环境变量：ANTHROPIC / OPENAI 的 API key（CODECLAW_X 优先，其次原生 X）
 *
 * 不抛异常；超时 / 拒接 / 不可达视为"未探测到"。
 */

import type { ProviderType } from "../lib/config";

export interface DetectedProvider {
  type: ProviderType;
  /** 已就绪：local（HTTP 通）/ env（API key 设了）；可同时 */
  source: "http" | "env";
  /** 探测确认的 baseUrl（HTTP 路径）或推荐默认值（env 路径） */
  baseUrl: string;
  /** 探测到的 model id（HTTP 路径返回 / env 路径用默认） */
  model?: string;
  /** env 路径用：哪个 env 变量被命中 */
  envVar?: string;
}

export interface DetectOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** 单个 HTTP 探测超时（毫秒），默认 500ms */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 500;

/** 探测 LM Studio：GET /v1/models 期望 200 + { data: [...] } 形式 */
async function probeLmStudio(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<DetectedProvider | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetchImpl(`${baseUrl}/models`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const body = (await r.json()) as { data?: Array<{ id?: string }> };
    const firstModel = body.data?.[0]?.id;
    return {
      type: "lmstudio",
      source: "http",
      baseUrl,
      ...(firstModel ? { model: firstModel } : {}),
    };
  } catch {
    return null;
  }
}

/** 探测 Ollama：GET /api/tags 期望 200 + { models: [...] } 形式 */
async function probeOllama(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<DetectedProvider | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetchImpl(`${baseUrl}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const body = (await r.json()) as { models?: Array<{ name?: string }> };
    const firstModel = body.models?.[0]?.name;
    return {
      type: "ollama",
      source: "http",
      baseUrl,
      ...(firstModel ? { model: firstModel } : {}),
    };
  } catch {
    return null;
  }
}

/** 同时探测两个本地 provider */
export async function detectLocalProviders(
  opts: DetectOptions = {}
): Promise<DetectedProvider[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results = await Promise.all([
    probeLmStudio("http://127.0.0.1:1234/v1", fetchImpl, timeoutMs),
    probeOllama("http://127.0.0.1:11434", fetchImpl, timeoutMs),
  ]);
  return results.filter((r): r is DetectedProvider => r !== null);
}

/** 扫 env 中已设的 cloud API key */
export function detectEnvProviders(env: NodeJS.ProcessEnv = process.env): DetectedProvider[] {
  const out: DetectedProvider[] = [];

  const anthropicVar =
    (env.CODECLAW_ANTHROPIC_API_KEY?.trim() && "CODECLAW_ANTHROPIC_API_KEY") ||
    (env.ANTHROPIC_API_KEY?.trim() && "ANTHROPIC_API_KEY") ||
    null;
  if (anthropicVar) {
    out.push({
      type: "anthropic",
      source: "env",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      envVar: anthropicVar,
    });
  }

  const openaiVar =
    (env.CODECLAW_OPENAI_API_KEY?.trim() && "CODECLAW_OPENAI_API_KEY") ||
    (env.OPENAI_API_KEY?.trim() && "OPENAI_API_KEY") ||
    null;
  if (openaiVar) {
    out.push({
      type: "openai",
      source: "env",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      envVar: openaiVar,
    });
  }

  return out;
}

/** 一站式：本地 HTTP + env，按推荐顺序返回 */
export async function detectAllProviders(
  opts: DetectOptions = {}
): Promise<DetectedProvider[]> {
  const [local, env] = await Promise.all([
    detectLocalProviders(opts),
    Promise.resolve(detectEnvProviders(opts.env)),
  ]);
  // 推荐顺序：local 优先（无费用），其次 cloud env
  return [...local, ...env];
}
