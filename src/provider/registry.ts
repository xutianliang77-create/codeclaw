import type { CodeClawConfig, ConfigPaths, ProvidersFileConfig, ProviderType } from "../lib/config";
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

function mergeProviderConfig(
  definition: ProviderDefinition,
  fileConfig: ProvidersFileConfig
): ResolvedProviderConfig {
  const configEntry = fileConfig[definition.type] ?? {};
  const envVars = Array.from(
    new Set(configEntry.apiKeyEnvVar ? [configEntry.apiKeyEnvVar, ...definition.envVars] : definition.envVars)
  );
  const apiKeyFromEnv = readEnvValue(envVars);

  return {
    type: definition.type,
    displayName: definition.displayName,
    kind: definition.kind,
    enabled: configEntry.enabled ?? true,
    requiresApiKey: definition.requiresApiKey,
    baseUrl: configEntry.baseUrl ?? definition.defaultBaseUrl,
    model: configEntry.model ?? definition.defaultModel,
    timeoutMs: configEntry.timeoutMs ?? definition.defaultTimeoutMs,
    apiKey: apiKeyFromEnv.value,
    apiKeyEnvVar: apiKeyFromEnv.envVar,
    envVars,
    fileConfig: configEntry,
    maxTokens: configEntry.maxTokens,
    contextWindow: configEntry.contextWindow,
  };
}

async function probeLocalProvider(config: ResolvedProviderConfig, fetchImpl: FetchLike): Promise<boolean> {
  const urlCandidates =
    config.type === "ollama"
      ? [`${config.baseUrl}/api/tags`, `${config.baseUrl}/v1/models`]
      : [`${config.baseUrl}/models`, `${config.baseUrl}/v1/models`];

  for (const url of urlCandidates) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.timeout(config.timeoutMs)
      });

      if (response.ok) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
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

  const reachable = await probeLocalProvider(config, fetchImpl);

  return {
    ...config,
    configured: true,
    available: reachable,
    reason: reachable ? "local endpoint reachable" : `local endpoint unreachable (${config.baseUrl})`
  };
}

export class ProviderRegistry {
  constructor(private readonly statuses: Map<ProviderType, ProviderStatus>) {}

  static async create(options?: {
    paths?: ConfigPaths;
    fetchImpl?: FetchLike;
    providersFile?: ProvidersFileConfig;
  }): Promise<ProviderRegistry> {
    const fetchImpl = options?.fetchImpl ?? fetch;
    const providersFile = options?.providersFile ?? (await readProvidersFile(options?.paths)) ?? createDefaultProvidersFile();
    const entries = await Promise.all(
      BUILTIN_PROVIDER_DEFINITIONS.map(async (definition) => {
        const resolvedConfig = mergeProviderConfig(definition, providersFile);
        const status = await buildProviderStatus(resolvedConfig, fetchImpl);
        return [definition.type, status] as const;
      })
    );

    return new ProviderRegistry(new Map(entries));
  }

  list(): ProviderStatus[] {
    return BUILTIN_PROVIDER_DEFINITIONS.map((definition) => {
      const status = this.statuses.get(definition.type);
      if (!status) {
        throw new Error(`Provider status missing for ${definition.type}`);
      }

      return status;
    });
  }

  get(type: ProviderType): ProviderStatus {
    const status = this.statuses.get(type);
    if (!status) {
      throw new Error(`Unknown provider: ${type}`);
    }

    return status;
  }

  select(config: CodeClawConfig): ProviderSelection {
    const current = this.get(config.provider.default);
    const fallback = this.get(config.provider.fallback);

    if (current.available) {
      return { current, fallback };
    }

    if (fallback.available) {
      return { current: fallback, fallback: current };
    }

    const firstAvailable = this.list().find((provider) => provider.available) ?? null;
    return { current: firstAvailable, fallback: current };
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
    return {
      config: null,
      registry,
      selection: null
    };
  }

  return {
    config,
    registry,
    selection: registry.select(config)
  };
}
