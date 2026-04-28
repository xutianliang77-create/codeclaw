import type { ProviderFileEntry, ProviderType } from "../lib/config";

export type ProviderKind = "cloud" | "local";

export interface ProviderDefinition {
  type: ProviderType;
  displayName: string;
  kind: ProviderKind;
  requiresApiKey: boolean;
  envVars: string[];
  defaultBaseUrl: string;
  defaultModel: string;
  defaultTimeoutMs: number;
}

export interface ResolvedProviderConfig {
  /** v0.7.1+ 多实例：providers.json 的 key（如 "lmstudio:default"） */
  instanceId: string;
  type: ProviderType;
  /** 来自 entry.displayName ?? definition.displayName + ":" + suffix */
  displayName: string;
  kind: ProviderKind;
  enabled: boolean;
  requiresApiKey: boolean;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKey?: string;
  apiKeyEnvVar?: string;
  envVars: string[];
  fileConfig: ProviderFileEntry;
  /** 用户在 providers.json 配置的 max_tokens；client 找不到时走默认 32_768 */
  maxTokens?: number;
  /** 用户在 providers.json 配置的 context window；token budget 优先用这里，次按模型名查表 */
  contextWindow?: number;
}

export interface ProviderStatus extends ResolvedProviderConfig {
  configured: boolean;
  available: boolean;
  reason: string;
}

export interface ProviderSelection {
  current: ProviderStatus | null;
  fallback: ProviderStatus | null;
}
