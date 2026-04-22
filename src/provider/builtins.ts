import type { ProviderDefinition } from "./types";

export const BUILTIN_PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    type: "anthropic",
    displayName: "Anthropic",
    kind: "cloud",
    requiresApiKey: true,
    envVars: ["CODECLAW_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-6",
    defaultTimeoutMs: 30_000
  },
  {
    type: "openai",
    displayName: "OpenAI",
    kind: "cloud",
    requiresApiKey: true,
    envVars: ["CODECLAW_OPENAI_API_KEY", "OPENAI_API_KEY"],
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    defaultTimeoutMs: 30_000
  },
  {
    type: "ollama",
    displayName: "Ollama",
    kind: "local",
    requiresApiKey: false,
    envVars: ["CODECLAW_OLLAMA_API_KEY", "OLLAMA_API_KEY"],
    defaultBaseUrl: "http://127.0.0.1:11434",
    defaultModel: "llama3.1",
    defaultTimeoutMs: 60_000
  },
  {
    type: "lmstudio",
    displayName: "LM Studio",
    kind: "local",
    requiresApiKey: false,
    envVars: ["CODECLAW_LMSTUDIO_API_KEY", "LMSTUDIO_API_KEY"],
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    defaultModel: "local-model",
    defaultTimeoutMs: 60_000
  }
];
