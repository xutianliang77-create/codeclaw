import type {
  CodeClawConfig,
  ConfigPaths,
  ProviderInstanceEntry,
  ProvidersFileConfig
} from "../lib/config";
import { createDefaultProvidersFile, readConfig, readProvidersFile, resolveConfigPaths } from "../lib/config";
import { BUILTIN_PROVIDER_DEFINITIONS } from "./builtins";
import type { ProviderDefinition, ProviderSelection, ProviderStatus, ResolvedProviderConfig } from "./types";

type FetchLike = typeof fetch;

function readEnvValue(envVars: string[]): { value?: string; envVar?: string } {
  for (const envVar of envVars) {
    const value = process.env[envVar];
    if (value) {
      return { value, envVar };
    }
  }

  return {};
}

function instanceDisplayName(
  instanceId: string,
  entry: ProviderInstanceEntry,
  definition: ProviderDefinition
): string {
  if (entry.displayName && entry.displayName.trim()) return entry.displayName.trim();
  // instanceId 形如 "lmstudio:default" → "LM Studio · default"
  const idx = instanceId.indexOf(":");
  if (idx > 0) {
    const suffix = instanceId.slice(idx + 1);
    return `${definition.displayName} · ${suffix}`;
  }
  return definition.displayName;
}

function mergeProviderConfig(
  instanceId: string,
  definition: ProviderDefinition,
  entry: ProviderInstanceEntry
): ResolvedProviderConfig {
  const envVars = Array.from(
    new Set(entry.apiKeyEnvVar ? [entry.apiKeyEnvVar, ...definition.envVars] : definition.envVars)
  );
  const apiKeyFromEnv = readEnvValue(envVars);

  return {
    instanceId,
    type: definition.type,
    displayName: instanceDisplayName(instanceId, entry, definition),
    kind: definition.kind,
    enabled: entry.enabled ?? true,
    requiresApiKey: definition.requiresApiKey,
    baseUrl: entry.baseUrl ?? definition.defaultBaseUrl,
    model: entry.model ?? definition.defaultModel,
    timeoutMs: entry.timeoutMs ?? definition.defaultTimeoutMs,
    apiKey: apiKeyFromEnv.value,
    apiKeyEnvVar: apiKeyFromEnv.envVar,
    envVars,
    fileConfig: entry,
    maxTokens: entry.maxTokens,
    contextWindow: entry.contextWindow,
  };
}

function isLocalHostUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "::1" || host === "0.0.0.0" || host.startsWith("127.");
  } catch {
    return false;
  }
}

interface ProbeOutcome {
  reachable: boolean;
  reason: string;
}

async function probeLocalProvider(
  config: ResolvedProviderConfig,
  fetchImpl: FetchLike
): Promise<ProbeOutcome> {
  // 远程 baseUrl（非 localhost/127.*）：Node fetch 在公网 HTTP 上有 IPv6 优先 / undici socket 复用 /
  // macOS 系统代理拦截等多种假阳性失败模式，curl 通而 fetch 判 unreachable 的现象已多次复现。
  // 用户既然主动配置远程地址就是有意的，事前 probe 不该当成 gate；真正能否调用留给首次实际请求报错。
  if (!isLocalHostUrl(config.baseUrl)) {
    return {
      reachable: true,
      reason: `remote endpoint ${config.baseUrl} (probe skipped — trust user config)`
    };
  }

  const urlCandidates =
    config.type === "ollama"
      ? [`${config.baseUrl}/api/tags`, `${config.baseUrl}/v1/models`]
      : [`${config.baseUrl}/models`, `${config.baseUrl}/v1/models`];

  let lastError: string | null = null;
  for (const url of urlCandidates) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.timeout(config.timeoutMs)
      });

      if (response.ok) {
        return { reachable: true, reason: `local endpoint reachable (${url})` };
      }
      lastError = `${url} → HTTP ${response.status}`;
    } catch (err) {
      lastError = `${url} → ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    reachable: false,
    reason: `local endpoint unreachable: ${lastError ?? `no candidate matched ${config.baseUrl}`}`
  };
}

async function buildProviderStatus(
  config: ResolvedProviderConfig,
  fetchImpl: FetchLike
): Promise<ProviderStatus> {
  if (!config.enabled) {
    return {
      ...config,
      configured: false,
      available: false,
      reason: "disabled in providers.json"
    };
  }

  if (config.requiresApiKey && !config.apiKey) {
    return {
      ...config,
      configured: false,
      available: false,
      reason: `missing API key (${config.envVars.join(" or ")})`
    };
  }

  if (config.kind === "cloud") {
    return {
      ...config,
      configured: true,
      available: true,
      reason: `configured via ${config.apiKeyEnvVar ?? "environment"}`
    };
  }

  // CODECLAW_SKIP_PROVIDER_PROBE=1 跳过 probe（fetch 假失败时退路）
  if (process.env.CODECLAW_SKIP_PROVIDER_PROBE === "1") {
    return {
      ...config,
      configured: true,
      available: true,
      reason: "probe skipped via CODECLAW_SKIP_PROVIDER_PROBE=1"
    };
  }

  const probe = await probeLocalProvider(config, fetchImpl);

  return {
    ...config,
    configured: true,
    available: probe.reachable,
    reason: probe.reason
  };
}

export class ProviderRegistry {
  constructor(private readonly statuses: Map<string /* instanceId */, ProviderStatus>) {}

  static async create(options?: {
    paths?: ConfigPaths;
    fetchImpl?: FetchLike;
    providersFile?: ProvidersFileConfig;
  }): Promise<ProviderRegistry> {
    const fetchImpl = options?.fetchImpl ?? fetch;
    const providersFile = options?.providersFile ?? (await readProvidersFile(options?.paths)) ?? createDefaultProvidersFile();
    const definitionsByType = new Map(BUILTIN_PROVIDER_DEFINITIONS.map((d) => [d.type, d]));
    const entries = await Promise.all(
      Object.entries(providersFile).map(async ([instanceId, entry]) => {
        const definition = definitionsByType.get(entry.type);
        if (!definition) return null;
        const resolvedConfig = mergeProviderConfig(instanceId, definition, entry);
        const status = await buildProviderStatus(resolvedConfig, fetchImpl);
        return [instanceId, status] as const;
      })
    );

    const valid = entries.filter((e): e is readonly [string, ProviderStatus] => e !== null);
    return new ProviderRegistry(new Map(valid));
  }

  list(): ProviderStatus[] {
    return Array.from(this.statuses.values());
  }

  /** 按 instanceId 取；不存在返回 undefined（旧版按 ProviderType 抛错的行为已弃） */
  get(instanceId: string): ProviderStatus | undefined {
    return this.statuses.get(instanceId);
  }

  /** 取首个该 type 的实例（兼容旧调用，比如 doctor 里仍想"看 anthropic 状态"） */
  firstByType(type: string): ProviderStatus | undefined {
    return this.list().find((s) => s.type === type);
  }

  select(config: CodeClawConfig): ProviderSelection {
    const current = this.get(config.provider.default);
    const fallback = this.get(config.provider.fallback);

    if (current?.available) {
      return { current, fallback: fallback ?? null };
    }

    if (fallback?.available) {
      return { current: fallback, fallback: current ?? null };
    }

    const firstAvailable = this.list().find((p) => p.available) ?? null;
    return { current: firstAvailable, fallback: current ?? null };
  }
}

export async function loadRuntimeSelection(options?: {
  paths?: ConfigPaths;
  fetchImpl?: FetchLike;
}): Promise<{
  config: CodeClawConfig | null;
  registry: ProviderRegistry;
  selection: ProviderSelection | null;
}> {
  const paths = options?.paths ?? resolveConfigPaths();
  const config = await readConfig(paths);
  const registry = await ProviderRegistry.create({
    paths,
    fetchImpl: options?.fetchImpl
  });

  if (!config) {
    // 没 config.yaml 时仍允许跑：取 registry 里第一个 available 实例兜底
    const firstAvailable = registry.list().find((p) => p.available) ?? null;
    return {
      config: null,
      registry,
      selection: firstAvailable ? { current: firstAvailable, fallback: null } : null
    };
  }

  return {
    config,
    registry,
    selection: registry.select(config)
  };
}
