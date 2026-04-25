import React, { useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import { SafeTextInput } from "./SafeTextInput";
import type { CodeClawConfig, ConfigPaths, ProviderFileEntry, ProviderType, ProvidersFileConfig } from "../lib/config";
import { writeConfig, writeProvidersFile } from "../lib/config";

type Screen =
  | "main"
  | "default"
  | "fallback"
  | "pick-provider"
  | "provider-menu"
  | "field-input"
  | "done";

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
    apiKeyEnvVar: entry?.apiKeyEnvVar
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
      { label: "Save and exit", value: "save" },
      { label: "Exit without saving", value: "exit" }
    ],
    [config.provider.default, config.provider.fallback]
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
    setFieldValue(field === "timeoutMs" ? String(current.timeoutMs ?? "") : String(current[field] ?? ""));
    setScreen("field-input");
  }

  function submitField(): void {
    const trimmed = fieldValue.trim();

    updateProvider(selectedProvider, (current) => {
      if (selectedField === "timeoutMs") {
        return {
          ...current,
          timeoutMs: trimmed ? Number.parseInt(trimmed, 10) : undefined
        };
      }

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
    setBanner(`Saved ${paths.configFile} and ${paths.providersFile}`);
    setScreen("done");
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

                if (item.value === "save") {
                  void save();
                  return;
                }

                exit();
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
              {selectedField === "timeoutMs"
                ? "Number or blank. Enter saves; ESC cancels; Ctrl+C exits."
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
            <Text>Press Ctrl+C to exit.</Text>
          </>
        ) : null}
      </Box>
    </Box>
  );
}
