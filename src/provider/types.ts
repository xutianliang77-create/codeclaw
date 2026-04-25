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
  type: ProviderType;
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
  /** 用户在 providers.json 配置的 max_tokens；client 找不到时走默认（OpenAI compat 4096 / Anthropic 1024） */
  maxTokens?: number;
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
