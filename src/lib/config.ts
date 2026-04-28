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

export const PROVIDER_TYPES: readonly ProviderType[] = [
  "anthropic",
  "openai",
  "ollama",
  "lmstudio"
] as const;

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
    /** instance id（v0.7.1+），形如 "lmstudio:default"。旧 ProviderType 字符串读取时自动迁移 */
    default: string;
    fallback: string;
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
  /** 单次请求 max_tokens 上限；不传走 client 默认 32_768 */
  maxTokens?: number;
  /** 模型 context window；不传时按 model 名字查表 fallback。LM Studio / vLLM 等
   *  可调 ctx 的本地 backend 必须显式声明，否则 token budget / autoCompact 按默认估，
   *  会比真 ctx 早触发压缩 */
  contextWindow?: number;
}

/** v0.7.1+ 多实例 entry：在 ProviderFileEntry 基础上必带 type，可选 displayName */
export interface ProviderInstanceEntry extends ProviderFileEntry {
  type: ProviderType;
  /** 用户自定义可读名，UI 用；未设走 instanceId */
  displayName?: string;
}

/** 文件 schema：key=instanceId（如 "lmstudio:default" / "openai:gpt5"），value 必带 type */
export type ProvidersFileConfig = Record<string, ProviderInstanceEntry>;

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
      default: "anthropic:default",
      fallback: "openai:default"
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
    "anthropic:default": {
      type: "anthropic",
      enabled: true,
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
      apiKeyEnvVar: "CODECLAW_ANTHROPIC_API_KEY"
    },
    "openai:default": {
      type: "openai",
      enabled: true,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      timeoutMs: 30_000,
      apiKeyEnvVar: "CODECLAW_OPENAI_API_KEY"
    },
    "ollama:default": {
      type: "ollama",
      enabled: true,
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.1",
      timeoutMs: 60_000
    },
    "lmstudio:default": {
      type: "lmstudio",
      enabled: true,
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-model",
      timeoutMs: 60_000
    }
  };
}

/**
 * 读到磁盘上的旧/新格式都归一化成新 schema：
 *   - 旧：`{ lmstudio: { baseUrl, ... } }`（key 是 ProviderType，value 没 type）
 *   - 新：`{ "lmstudio:default": { type: "lmstudio", baseUrl, ... } }`
 * 旧 entry 自动重命名为 `<type>:default` 单实例。
 */
export function migrateProvidersFile(raw: unknown): ProvidersFileConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ProvidersFileConfig = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.type === "string" && (PROVIDER_TYPES as readonly string[]).includes(v.type)) {
      out[key] = v as unknown as ProviderInstanceEntry;
      continue;
    }
    if ((PROVIDER_TYPES as readonly string[]).includes(key)) {
      out[`${key}:default`] = {
        type: key as ProviderType,
        ...(v as Omit<ProviderInstanceEntry, "type">)
      };
    }
  }
  return out;
}

/**
 * config.yaml 的 provider.default/fallback 在旧文件里是裸 ProviderType
 * （如 "lmstudio"），新 schema 要 instance id（"lmstudio:default"）。
 * 若值是裸 type 且对应 `<type>:default` 实例存在，自动改写。
 */
export function migrateConfigSelection(
  config: CodeClawConfig,
  providers: ProvidersFileConfig
): CodeClawConfig {
  const map = (id: string): string => {
    if (providers[id]) return id;
    if ((PROVIDER_TYPES as readonly string[]).includes(id) && providers[`${id}:default`]) {
      return `${id}:default`;
    }
    return id;
  };
  const nextDefault = map(config.provider.default);
  const nextFallback = map(config.provider.fallback);
  if (nextDefault === config.provider.default && nextFallback === config.provider.fallback) {
    return config;
  }
  return {
    ...config,
    provider: { default: nextDefault, fallback: nextFallback }
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
    return migrateProvidersFile(JSON.parse(raw));
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
  const providers = (await readProvidersFile(paths)) ?? createDefaultProvidersFile();
  const rawConfig = (await readConfig(paths)) ?? createDefaultConfig();
  const config = migrateConfigSelection(rawConfig, providers);
  return { config, providers };
}
