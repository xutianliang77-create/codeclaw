import React, { useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import { SafeTextInput } from "./SafeTextInput";
import type { CodeClawConfig, ConfigPaths, ProviderFileEntry, ProviderType, ProvidersFileConfig } from "../lib/config";
import { writeConfig, writeProvidersFile } from "../lib/config";
import {
  ensureWebToken,
  generateWebToken,
  readWebAuthFile,
  webAuthFilePath,
  writeWebAuthFile,
} from "../channels/web/auth";

type Screen =
  | "main"
  | "default"
  | "fallback"
  | "pick-provider"
  | "provider-menu"
  | "field-input"
  | "web-token"
  | "done";

/** token 显示掩码：前 4 + ... + 后 4 字符；过短直接 *** */
function maskToken(t: string): string {
  if (!t || t.length < 12) return "***";
  return `${t.slice(0, 4)}...${t.slice(-4)}`;
}

type MenuItem = {
  label: string;
  value: string;
};

type EditableField = keyof ProviderFileEntry;

type ProviderConfigAppProps = {
  initialConfig: CodeClawConfig;
  initialProviders: ProvidersFileConfig;
  paths: ConfigPaths;
  mode: "setup" | "config";
};

const PROVIDERS: ProviderType[] = ["anthropic", "openai", "ollama", "lmstudio"];

function cloneProviders(input: ProvidersFileConfig): ProvidersFileConfig {
  return JSON.parse(JSON.stringify(input)) as ProvidersFileConfig;
}

function normalizeEntry(entry: ProviderFileEntry | undefined): ProviderFileEntry {
  return {
    enabled: entry?.enabled ?? true,
    baseUrl: entry?.baseUrl ?? "",
    model: entry?.model ?? "",
    timeoutMs: entry?.timeoutMs,
    apiKeyEnvVar: entry?.apiKeyEnvVar,
    maxTokens: entry?.maxTokens,
    contextWindow: entry?.contextWindow
  };
}

function summaryLine(type: ProviderType, entry: ProviderFileEntry | undefined): string {
  const normalized = normalizeEntry(entry);
  return [
    type,
    `enabled=${normalized.enabled ? "true" : "false"}`,
    `model=${normalized.model || "-"}`,
    `baseUrl=${normalized.baseUrl || "-"}`,
    `timeoutMs=${normalized.timeoutMs ?? "-"}`,
    `maxTokens=${normalized.maxTokens ?? "-"}`,
    `contextWindow=${normalized.contextWindow ?? "-"}`,
    `apiKeyEnvVar=${normalized.apiKeyEnvVar || "-"}`
  ].join(" | ");
}

export function ProviderConfigApp({
  initialConfig,
  initialProviders,
  paths,
  mode
}: ProviderConfigAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("main");
  const [config, setConfig] = useState<CodeClawConfig>(initialConfig);
  const [providers, setProviders] = useState<ProvidersFileConfig>(cloneProviders(initialProviders));
  const [selectedProvider, setSelectedProvider] = useState<ProviderType>("anthropic");
  const [selectedField, setSelectedField] = useState<EditableField>("baseUrl");
  const [fieldValue, setFieldValue] = useState("");
  const [banner, setBanner] = useState(
    mode === "setup"
      ? "Interactive setup ready. Configure providers and save."
      : "Interactive provider config ready."
  );
  const [webTokenInfo, setWebTokenInfo] = useState<{ token: string; path: string } | null>(
    () => {
      const fp = webAuthFilePath();
      const f = readWebAuthFile(fp);
      return f ? { token: f.token, path: fp } : null;
    }
  );
  const [savedTokenJustNow, setSavedTokenJustNow] = useState(false);

  // Ctrl+C 全退；ESC 回主菜单（编辑屏也生效，因为 SafeTextInput 不再吞 ESC）
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (key.escape && screen !== "done") {
      setScreen("main");
      setBanner("Returned to main menu.");
    }
  });

  const mainItems = useMemo<MenuItem[]>(
    () => [
      { label: `Set default provider (${config.provider.default})`, value: "default" },
      { label: `Set fallback provider (${config.provider.fallback})`, value: "fallback" },
      { label: "Edit provider settings", value: "provider" },
      {
        label: `Web token (${webTokenInfo ? "✓ " + maskToken(webTokenInfo.token) : "未生成"})`,
        value: "web-token",
      },
      { label: "Save and exit", value: "save" },
      { label: "Exit without saving", value: "exit" }
    ],
    [config.provider.default, config.provider.fallback, webTokenInfo]
  );

  const webTokenMenuItems = useMemo<MenuItem[]>(
    () => [
      { label: webTokenInfo ? "已生成；查看完整 token（在下方）" : "生成 token", value: "ensure" },
      { label: "重新生成（覆盖旧 token）", value: "regenerate" },
      { label: "Back", value: "back" },
    ],
    [webTokenInfo]
  );

  const providerItems = useMemo<MenuItem[]>(
    () =>
      PROVIDERS.map((provider) => ({
        label: provider,
        value: provider
      })),
    []
  );

  const providerMenuItems = useMemo<MenuItem[]>(() => {
    const current = normalizeEntry(providers[selectedProvider]);
    return [
      { label: `enabled (${current.enabled ? "true" : "false"})`, value: "enabled" },
      { label: `baseUrl (${current.baseUrl || "-"})`, value: "baseUrl" },
      { label: `model (${current.model || "-"})`, value: "model" },
      { label: `timeoutMs (${current.timeoutMs ?? "-"})`, value: "timeoutMs" },
      { label: `maxTokens (${current.maxTokens ?? "-"})`, value: "maxTokens" },
      { label: `contextWindow (${current.contextWindow ?? "-"})`, value: "contextWindow" },
      { label: `apiKeyEnvVar (${current.apiKeyEnvVar || "-"})`, value: "apiKeyEnvVar" },
      { label: "Back", value: "back" }
    ];
  }, [providers, selectedProvider]);

  function updateProvider(
    provider: ProviderType,
    updater: (current: ProviderFileEntry) => ProviderFileEntry
  ): void {
    setProviders((current) => {
      const next = cloneProviders(current);
      next[provider] = updater(normalizeEntry(next[provider]));
      return next;
    });
  }

  function startFieldEdit(field: EditableField): void {
    if (field === "enabled") {
      updateProvider(selectedProvider, (current) => ({
        ...current,
        enabled: !(current.enabled ?? true)
      }));
      setBanner(`Updated ${selectedProvider}.enabled`);
      return;
    }

    const current = normalizeEntry(providers[selectedProvider]);
    setSelectedField(field);
    if (field === "timeoutMs" || field === "maxTokens" || field === "contextWindow") {
      setFieldValue(String(current[field] ?? ""));
    } else {
      setFieldValue(String(current[field] ?? ""));
    }
    setScreen("field-input");
  }

  function submitField(): void {
    const trimmed = fieldValue.trim();
    const numericFields: EditableField[] = ["timeoutMs", "maxTokens", "contextWindow"];

    if (numericFields.includes(selectedField)) {
      // 留空清字段（撤销显式声明，回退到默认表）
      if (trimmed === "") {
        updateProvider(selectedProvider, (current) => ({
          ...current,
          [selectedField]: undefined,
        }));
        setBanner(`Cleared ${selectedProvider}.${selectedField}（恢复默认）`);
        setScreen("provider-menu");
        return;
      }
      const n = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(n) || Number.isNaN(n) || n <= 0 || String(n) !== trimmed) {
        // 非整数 / 0 / 负数 → reject，留在编辑屏让用户改
        setBanner(`${selectedField} 需为正整数（输入 "${trimmed}" 不合法）`);
        return;
      }
      updateProvider(selectedProvider, (current) => ({
        ...current,
        [selectedField]: n,
      }));
      setBanner(`Updated ${selectedProvider}.${selectedField} = ${n}`);
      setScreen("provider-menu");
      return;
    }

    updateProvider(selectedProvider, (current) => {
      if (selectedField === "apiKeyEnvVar") {
        return {
          ...current,
          apiKeyEnvVar: trimmed || undefined
        };
      }

      return {
        ...current,
        [selectedField]: trimmed
      };
    });

    setBanner(`Updated ${selectedProvider}.${selectedField}`);
    setScreen("provider-menu");
  }

  async function save(): Promise<void> {
    await writeConfig(config, paths);
    await writeProvidersFile(providers, paths);
    // P2.3：保存配置时顺手 ensure web token；已存在不覆盖
    const { token, generated } = ensureWebToken();
    if (generated || !webTokenInfo) {
      setWebTokenInfo({ token, path: webAuthFilePath() });
      setSavedTokenJustNow(generated);
    }
    setBanner(`Saved ${paths.configFile} and ${paths.providersFile}`);
    setScreen("done");
  }

  function handleWebTokenAction(action: "ensure" | "regenerate"): void {
    const fp = webAuthFilePath();
    if (action === "ensure") {
      const { token, generated } = ensureWebToken(fp);
      setWebTokenInfo({ token, path: fp });
      setSavedTokenJustNow(generated);
      setBanner(generated ? `已生成 web token，保存到 ${fp}` : `已读取现有 token: ${fp}`);
    } else {
      // regenerate：覆盖
      const fresh = generateWebToken();
      writeWebAuthFile(fresh, fp);
      setWebTokenInfo({ token: fresh.token, path: fp });
      setSavedTokenJustNow(true);
      setBanner(`已重新生成 web token，保存到 ${fp}`);
    }
    setScreen("main");
  }

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text>CodeClaw Provider Config</Text>
        <Text color="gray">mode: {mode} | Esc back | Ctrl+C exit</Text>
      </Box>

      <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
        <Text color="yellow">{banner}</Text>
      </Box>

      <Box borderStyle="round" paddingX={1} flexDirection="column" marginTop={1}>
        <Text>
          default={config.provider.default} | fallback={config.provider.fallback} | permission=
          {config.defaults.permissionMode}
        </Text>
        {PROVIDERS.map((provider) => (
          <Text key={provider}>{summaryLine(provider, providers[provider])}</Text>
        ))}
      </Box>

      <Box borderStyle="round" paddingX={1} flexDirection="column" marginTop={1}>
        {screen === "main" ? (
          <>
            <Text>Main Menu</Text>
            <SelectInput
              items={mainItems}
              onSelect={(item) => {
                if (item.value === "default") {
                  setScreen("default");
                  return;
                }

                if (item.value === "fallback") {
                  setScreen("fallback");
                  return;
                }

                if (item.value === "provider") {
                  setScreen("pick-provider");
                  return;
                }

                if (item.value === "web-token") {
                  setScreen("web-token");
                  return;
                }

                if (item.value === "save") {
                  void save();
                  return;
                }

                exit();
              }}
            />
          </>
        ) : null}

        {screen === "web-token" ? (
          <>
            <Text>Web token · ~/.codeclaw/web-auth.json</Text>
            {webTokenInfo ? (
              <Text color="gray">当前: {maskToken(webTokenInfo.token)}（路径: {webTokenInfo.path}）</Text>
            ) : (
              <Text color="gray">尚未生成；首次启动 codeclaw web 也会自动生成</Text>
            )}
            <SelectInput
              items={webTokenMenuItems}
              onSelect={(item) => {
                if (item.value === "back") {
                  setScreen("main");
                  return;
                }
                handleWebTokenAction(item.value as "ensure" | "regenerate");
              }}
            />
          </>
        ) : null}

        {screen === "default" ? (
          <>
            <Text>Select default provider</Text>
            <SelectInput
              items={providerItems}
              onSelect={(item) => {
                setConfig((current) => ({
                  ...current,
                  provider: {
                    ...current.provider,
                    default: item.value as ProviderType
                  }
                }));
                setBanner(`Default provider set to ${item.value}`);
                setScreen("main");
              }}
            />
          </>
        ) : null}

        {screen === "fallback" ? (
          <>
            <Text>Select fallback provider</Text>
            <SelectInput
              items={providerItems}
              onSelect={(item) => {
                setConfig((current) => ({
                  ...current,
                  provider: {
                    ...current.provider,
                    fallback: item.value as ProviderType
                  }
                }));
                setBanner(`Fallback provider set to ${item.value}`);
                setScreen("main");
              }}
            />
          </>
        ) : null}

        {screen === "pick-provider" ? (
          <>
            <Text>Select provider to edit</Text>
            <SelectInput
              items={providerItems}
              onSelect={(item) => {
                setSelectedProvider(item.value as ProviderType);
                setBanner(`Editing ${item.value}`);
                setScreen("provider-menu");
              }}
            />
          </>
        ) : null}

        {screen === "provider-menu" ? (
          <>
            <Text>Edit provider: {selectedProvider}</Text>
            <SelectInput
              items={providerMenuItems}
              onSelect={(item) => {
                if (item.value === "back") {
                  setScreen("main");
                  return;
                }

                startFieldEdit(item.value as EditableField);
              }}
            />
          </>
        ) : null}

        {screen === "field-input" ? (
          <>
            <Text>
              Edit {selectedProvider}.{selectedField}
            </Text>
            <Text color="gray">
              {selectedField === "timeoutMs" ||
              selectedField === "maxTokens" ||
              selectedField === "contextWindow"
                ? "Positive integer or blank to clear. Enter saves; ESC cancels; Ctrl+C exits."
                : "Backspace/←→ edit. Ctrl+A=home Ctrl+E=end Ctrl+U=clear Ctrl+W=del-word. Enter saves; ESC cancels."}
            </Text>
            <Text color="gray">
              buffer length: {fieldValue.length}
            </Text>
            <Box marginTop={1}>
              <Text color="cyan">{"> "}</Text>
              <SafeTextInput value={fieldValue} onChange={setFieldValue} onSubmit={submitField} />
            </Box>
          </>
        ) : null}

        {screen === "done" ? (
          <>
            <Text color="green">Configuration saved.</Text>
            {webTokenInfo ? (
              <>
                <Text color="cyan">
                  Web token: {savedTokenJustNow ? webTokenInfo.token : maskToken(webTokenInfo.token)}
                </Text>
                <Text color="gray">
                  {savedTokenJustNow
                    ? `已保存到 ${webTokenInfo.path}（mode 0600，请复制保存——登录浏览器时输入）`
                    : `路径: ${webTokenInfo.path}`}
                </Text>
              </>
            ) : null}
            <Text>Press Ctrl+C to exit.</Text>
          </>
        ) : null}
      </Box>
    </Box>
  );
}
