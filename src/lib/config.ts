import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";

export type PermissionMode =
  | "default"
  | "plan"
  | "auto"
  | "acceptEdits"
  | "bypassPermissions"
  | "dontAsk";

export type ProviderType = "anthropic" | "openai" | "ollama" | "lmstudio";

export interface CodeClawConfig {
  speech?: {
    asr?: {
      enabled?: boolean;
      baseUrl?: string;
      model?: string;
      timeoutMs?: number;
      apiKeyEnvVar?: string;
      language?: string;
      prompt?: string;
    };
  };
  gateway?: {
    enabledChannels?: Array<{
      type: "cli" | "sdk" | "wechat" | "mcp" | "http";
    }>;
    bots?: {
      ilinkWechat?: {
        enabled?: boolean;
        tokenFile?: string;
        baseUrl?: string;
        pollIntervalMs?: number;
      };
    };
  };
  provider: {
    default: ProviderType;
    fallback: ProviderType;
  };
  defaults: {
    language: "zh" | "en";
    permissionMode: PermissionMode;
    workspace: string;
  };
  memory: {
    l1AutoCompactThreshold: number;
    l2Dir: string;
  };
}

export interface ProviderFileEntry {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  apiKeyEnvVar?: string;
}

export type ProvidersFileConfig = Partial<Record<ProviderType, ProviderFileEntry>>;

export interface ConfigPaths {
  configDir: string;
  configFile: string;
  providersFile: string;
  sessionsDir: string;
  approvalsDir: string;
  logsDir: string;
}

export function resolveConfigPaths(homeDir = homedir()): ConfigPaths {
  const configDir = path.join(homeDir, ".codeclaw");

  return {
    configDir,
    configFile: path.join(configDir, "config.yaml"),
    providersFile: path.join(configDir, "providers.json"),
    sessionsDir: path.join(configDir, "sessions"),
    approvalsDir: path.join(configDir, "approvals"),
    logsDir: path.join(configDir, "logs")
  };
}

export function createDefaultConfig(cwd = process.cwd()): CodeClawConfig {
  return {
    speech: {
      asr: {
        enabled: false,
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "whisper-1",
        timeoutMs: 60_000,
        apiKeyEnvVar: "CODECLAW_SPEECH_API_KEY",
        language: "zh"
      }
    },
    gateway: {
      enabledChannels: [{ type: "cli" }],
      bots: {
        ilinkWechat: {
          enabled: false,
          tokenFile: "~/.codeclaw/wechat-ibot/default.json",
          baseUrl: "https://ilinkai.weixin.qq.com",
          pollIntervalMs: 100
        }
      }
    },
    provider: {
      default: "anthropic",
      fallback: "openai"
    },
    defaults: {
      language: "zh",
      permissionMode: "plan",
      workspace: cwd
    },
    memory: {
      l1AutoCompactThreshold: 167_000,
      l2Dir: "~/.codeclaw/sessions/"
    }
  };
}

export function createDefaultProvidersFile(): ProvidersFileConfig {
  return {
    anthropic: {
      enabled: true,
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
      apiKeyEnvVar: "CODECLAW_ANTHROPIC_API_KEY"
    },
    openai: {
      enabled: true,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      timeoutMs: 30_000,
      apiKeyEnvVar: "CODECLAW_OPENAI_API_KEY"
    },
    ollama: {
      enabled: true,
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.1",
      timeoutMs: 60_000
    },
    lmstudio: {
      enabled: true,
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-model",
      timeoutMs: 60_000
    }
  };
}

export async function ensureConfigDirs(paths = resolveConfigPaths()): Promise<void> {
  await Promise.all([
    mkdir(paths.configDir, { recursive: true }),
    mkdir(paths.sessionsDir, { recursive: true }),
    mkdir(paths.approvalsDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true })
  ]);
}

export async function writeConfig(
  config: CodeClawConfig,
  paths = resolveConfigPaths()
): Promise<void> {
  await ensureConfigDirs(paths);
  const content = yaml.dump(config, { lineWidth: 100 });
  await writeFile(paths.configFile, content, "utf8");
}

export async function writeProvidersFile(
  config: ProvidersFileConfig,
  paths = resolveConfigPaths()
): Promise<void> {
  await ensureConfigDirs(paths);
  await writeFile(paths.providersFile, JSON.stringify(config, null, 2), "utf8");
}

export async function readConfig(
  paths = resolveConfigPaths()
): Promise<CodeClawConfig | null> {
  try {
    const raw = await readFile(paths.configFile, "utf8");
    return yaml.load(raw) as CodeClawConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function readProvidersFile(
  paths = resolveConfigPaths()
): Promise<ProvidersFileConfig | null> {
  try {
    const raw = await readFile(paths.providersFile, "utf8");
    return JSON.parse(raw) as ProvidersFileConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function loadEditableConfig(
  paths = resolveConfigPaths()
): Promise<{
  config: CodeClawConfig;
  providers: ProvidersFileConfig;
}> {
  return {
    config: (await readConfig(paths)) ?? createDefaultConfig(),
    providers: (await readProvidersFile(paths)) ?? createDefaultProvidersFile()
  };
}
