import React, { useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import { SafeTextInput } from "./SafeTextInput";
import type {
  CodeClawConfig,
  ConfigPaths,
  ProviderInstanceEntry,
  ProviderType,
  ProvidersFileConfig
} from "../lib/config";
import { PROVIDER_TYPES, writeConfig, writeProvidersFile } from "../lib/config";
import {
  ensureWebToken,
  generateWebToken,
  readWebAuthFile,
  webAuthFilePath,
  writeWebAuthFile,
} from "../channels/web/auth";
import { detectAllProviders, type DetectedProvider } from "../provider/detect";

type Screen =
  | "main"
  | "default"
  | "fallback"
  | "instances-list"
  | "pick-type-for-add"
  | "name-input"
  | "provider-menu"
  | "field-input"
  | "web-token"
  | "detecting"
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

type EditableField =
  | "enabled"
  | "baseUrl"
  | "model"
  | "timeoutMs"
  | "apiKeyEnvVar"
  | "maxTokens"
  | "contextWindow"
  | "displayName"
  | "rename"
  | "delete";

type ProviderConfigAppProps = {
  initialConfig: CodeClawConfig;
  initialProviders: ProvidersFileConfig;
  paths: ConfigPaths;
  mode: "setup" | "config";
};

function cloneProviders(input: ProvidersFileConfig): ProvidersFileConfig {
  return JSON.parse(JSON.stringify(input)) as ProvidersFileConfig;
}

function instanceSummary(id: string, entry: ProviderInstanceEntry): string {
  return [
    id,
    `type=${entry.type}`,
    `enabled=${entry.enabled ?? true}`,
    `model=${entry.model || "-"}`,
    `baseUrl=${entry.baseUrl || "-"}`,
    `timeoutMs=${entry.timeoutMs ?? "-"}`,
    `maxTokens=${entry.maxTokens ?? "-"}`,
    `contextWindow=${entry.contextWindow ?? "-"}`,
    `apiKeyEnvVar=${entry.apiKeyEnvVar || "-"}`,
  ].join(" | ");
}

const TYPE_DEFAULTS: Record<
  ProviderType,
  Pick<ProviderInstanceEntry, "baseUrl" | "model" | "timeoutMs" | "apiKeyEnvVar">
> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    timeoutMs: 30_000,
    apiKeyEnvVar: "CODECLAW_ANTHROPIC_API_KEY",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    timeoutMs: 30_000,
    apiKeyEnvVar: "CODECLAW_OPENAI_API_KEY",
  },
  ollama: {
    baseUrl: "http://127.0.0.1:11434",
    model: "llama3.1",
    timeoutMs: 60_000,
  },
  lmstudio: {
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    timeoutMs: 60_000,
  },
};

function makeFreshInstance(type: ProviderType): ProviderInstanceEntry {
  return {
    type,
    enabled: true,
    ...TYPE_DEFAULTS[type],
  };
}

/** 给给定 type 找一个不冲突的 instance id（type:default → type:1 → type:2） */
function nextInstanceId(type: ProviderType, existing: ProvidersFileConfig): string {
  const def = `${type}:default`;
  if (!existing[def]) return def;
  for (let i = 1; i < 100; i += 1) {
    const candidate = `${type}:${i}`;
    if (!existing[candidate]) return candidate;
  }
  return `${type}:${Date.now()}`;
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
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>(
    () => Object.keys(initialProviders)[0] ?? ""
  );
  const [pendingType, setPendingType] = useState<ProviderType | null>(null);
  const [pendingRename, setPendingRename] = useState<boolean>(false);
  const [selectedField, setSelectedField] = useState<EditableField>("baseUrl");
  const [fieldValue, setFieldValue] = useState("");
  const [banner, setBanner] = useState(
    mode === "setup"
      ? "Interactive setup ready. Configure provider instances and save.  ·  交互式 setup 就绪，请配置 provider 实例并保存。"
      : "Interactive provider config ready.  ·  交互式 provider 配置就绪。"
  );
  const [webTokenInfo, setWebTokenInfo] = useState<{ token: string; path: string } | null>(
    () => {
      const fp = webAuthFilePath();
      const f = readWebAuthFile(fp);
      return f ? { token: f.token, path: fp } : null;
    }
  );
  const [savedTokenJustNow, setSavedTokenJustNow] = useState(false);
  const [detectResults, setDetectResults] = useState<DetectedProvider[]>([]);

  // Ctrl+C 全退；ESC 回主菜单
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (key.escape && screen !== "done") {
      setScreen("main");
      setBanner("Returned to main menu.  ·  已返回主菜单。");
    }
  });

  const instanceIds = useMemo(() => Object.keys(providers), [providers]);

  const mainItems = useMemo<MenuItem[]>(
    () => [
      {
        label: `Manage instances · 管理实例 (${instanceIds.length})`,
        value: "instances",
      },
      {
        label: `Set default instance · 默认实例 (${config.provider.default})`,
        value: "default",
      },
      {
        label: `Set fallback instance · 备用实例 (${config.provider.fallback})`,
        value: "fallback",
      },
      { label: "Auto-detect providers · 自动探测可用 provider", value: "detect" },
      {
        label: `Web token · Web 鉴权令牌 (${
          webTokenInfo ? "✓ " + maskToken(webTokenInfo.token) : "未生成 / not set"
        })`,
        value: "web-token",
      },
      { label: "Save and exit · 保存并退出", value: "save" },
      { label: "Exit without saving · 不保存退出", value: "exit" }
    ],
    [config.provider.default, config.provider.fallback, instanceIds.length, webTokenInfo]
  );

  const webTokenMenuItems = useMemo<MenuItem[]>(
    () => [
      {
        label: webTokenInfo
          ? "Show existing · 查看现有 token（路径见下）"
          : "Generate now · 立即生成 token",
        value: "ensure",
      },
      { label: "Regenerate (overwrite) · 重新生成（覆盖旧 token）", value: "regenerate" },
      { label: "Back · 返回", value: "back" },
    ],
    [webTokenInfo]
  );

  const instanceListItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = instanceIds.map((id) => {
      const e = providers[id];
      const tag =
        id === config.provider.default
          ? " [default]"
          : id === config.provider.fallback
          ? " [fallback]"
          : "";
      return {
        label: `${id}${tag} · type=${e.type} model=${e.model || "-"} baseUrl=${e.baseUrl || "-"}`,
        value: `edit:${id}`,
      };
    });
    items.push({ label: "+ Add new instance · 新增实例", value: "add" });
    items.push({ label: "Back · 返回", value: "back" });
    return items;
  }, [instanceIds, providers, config.provider.default, config.provider.fallback]);

  const typePickItems = useMemo<MenuItem[]>(
    () =>
      PROVIDER_TYPES.map((t) => ({
        label: t,
        value: t,
      })),
    []
  );

  const selectedEntry: ProviderInstanceEntry | undefined = providers[selectedInstanceId];

  const providerMenuItems = useMemo<MenuItem[]>(() => {
    if (!selectedEntry) return [{ label: "Back · 返回", value: "back" }];
    return [
      { label: `enabled · 启用 (${selectedEntry.enabled ?? true})`, value: "enabled" },
      { label: `baseUrl · API 基址 (${selectedEntry.baseUrl || "-"})`, value: "baseUrl" },
      { label: `model · 模型 (${selectedEntry.model || "-"})`, value: "model" },
      { label: `timeoutMs · 超时(ms) (${selectedEntry.timeoutMs ?? "-"})`, value: "timeoutMs" },
      { label: `maxTokens · 单次最大 token (${selectedEntry.maxTokens ?? "-"})`, value: "maxTokens" },
      {
        label: `contextWindow · 上下文窗口 token (${selectedEntry.contextWindow ?? "-"})`,
        value: "contextWindow",
      },
      {
        label: `apiKeyEnvVar · API key env 变量 (${selectedEntry.apiKeyEnvVar || "-"})`,
        value: "apiKeyEnvVar",
      },
      {
        label: `displayName · 显示名 (${selectedEntry.displayName || "-"})`,
        value: "displayName",
      },
      { label: "Rename instance id · 重命名实例 id", value: "rename" },
      { label: "Delete instance · 删除实例", value: "delete" },
      { label: "Back · 返回", value: "back" },
    ];
  }, [selectedEntry]);

  const instanceSelectItems = useMemo<MenuItem[]>(
    () =>
      instanceIds.map((id) => ({
        label: `${id} · type=${providers[id].type}`,
        value: id,
      })),
    [instanceIds, providers]
  );

  function updateInstance(
    id: string,
    updater: (current: ProviderInstanceEntry) => ProviderInstanceEntry
  ): void {
    setProviders((current) => {
      const next = cloneProviders(current);
      const cur = next[id];
      if (!cur) return current;
      next[id] = updater(cur);
      return next;
    });
  }

  function startFieldEdit(field: EditableField): void {
    if (!selectedEntry) return;
    if (field === "enabled") {
      updateInstance(selectedInstanceId, (cur) => ({ ...cur, enabled: !(cur.enabled ?? true) }));
      setBanner(`Updated ${selectedInstanceId}.enabled · 已切换`);
      return;
    }
    if (field === "delete") {
      setProviders((current) => {
        const next = cloneProviders(current);
        delete next[selectedInstanceId];
        return next;
      });
      setBanner(`Deleted ${selectedInstanceId} · 已删除实例`);
      setSelectedInstanceId(instanceIds.find((id) => id !== selectedInstanceId) ?? "");
      setScreen("instances-list");
      return;
    }
    if (field === "rename") {
      setPendingRename(true);
      setFieldValue(selectedInstanceId);
      setScreen("name-input");
      return;
    }

    setSelectedField(field);
    const numericFields: EditableField[] = ["timeoutMs", "maxTokens", "contextWindow"];
    if (numericFields.includes(field)) {
      setFieldValue(String(selectedEntry[field as "timeoutMs" | "maxTokens" | "contextWindow"] ?? ""));
    } else if (field === "displayName") {
      setFieldValue(selectedEntry.displayName ?? "");
    } else {
      setFieldValue(String(selectedEntry[field as "baseUrl" | "model" | "apiKeyEnvVar"] ?? ""));
    }
    setScreen("field-input");
  }

  function submitField(): void {
    if (!selectedEntry) return;
    const trimmed = fieldValue.trim();
    const numericFields: EditableField[] = ["timeoutMs", "maxTokens", "contextWindow"];

    if (numericFields.includes(selectedField)) {
      if (trimmed === "") {
        updateInstance(selectedInstanceId, (cur) => ({ ...cur, [selectedField]: undefined }));
        setBanner(`Cleared ${selectedInstanceId}.${selectedField} · 已清空`);
        setScreen("provider-menu");
        return;
      }
      const n = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(n) || n <= 0 || String(n) !== trimmed) {
        setBanner(`${selectedField} 需为正整数 · positive integer required（输入 "${trimmed}" 不合法）`);
        return;
      }
      updateInstance(selectedInstanceId, (cur) => ({ ...cur, [selectedField]: n }));
      setBanner(`Updated ${selectedInstanceId}.${selectedField} = ${n} · 已更新`);
      setScreen("provider-menu");
      return;
    }

    updateInstance(selectedInstanceId, (cur) => {
      if (selectedField === "apiKeyEnvVar" || selectedField === "displayName") {
        return { ...cur, [selectedField]: trimmed || undefined };
      }
      return { ...cur, [selectedField]: trimmed };
    });
    setBanner(`Updated ${selectedInstanceId}.${selectedField} · 已更新`);
    setScreen("provider-menu");
  }

  function submitNameInput(): void {
    const trimmed = fieldValue.trim();
    if (!trimmed) {
      setBanner("Instance id 不能为空 · empty id rejected");
      return;
    }
    if (!/^[a-z0-9_:.-]+$/i.test(trimmed)) {
      setBanner("Instance id 仅允许 a-zA-Z0-9 _ : . - · invalid chars");
      return;
    }

    if (pendingRename) {
      if (trimmed !== selectedInstanceId && providers[trimmed]) {
        setBanner(`Id "${trimmed}" 已存在 · id taken`);
        return;
      }
      setProviders((current) => {
        const next = cloneProviders(current);
        const e = next[selectedInstanceId];
        if (!e) return current;
        delete next[selectedInstanceId];
        next[trimmed] = e;
        return next;
      });
      // 同步 default/fallback 引用
      setConfig((c) => {
        const next = { ...c, provider: { ...c.provider } };
        if (next.provider.default === selectedInstanceId) next.provider.default = trimmed;
        if (next.provider.fallback === selectedInstanceId) next.provider.fallback = trimmed;
        return next;
      });
      setSelectedInstanceId(trimmed);
      setPendingRename(false);
      setBanner(`Renamed → ${trimmed} · 已重命名`);
      setScreen("provider-menu");
      return;
    }

    if (pendingType) {
      if (providers[trimmed]) {
        setBanner(`Id "${trimmed}" 已存在 · id taken`);
        return;
      }
      const fresh = makeFreshInstance(pendingType);
      setProviders((current) => {
        const next = cloneProviders(current);
        next[trimmed] = fresh;
        return next;
      });
      setSelectedInstanceId(trimmed);
      setPendingType(null);
      setBanner(`Added ${trimmed} · 已新增实例`);
      setScreen("provider-menu");
      return;
    }
  }

  async function save(): Promise<void> {
    // 如果 default/fallback 引用的实例不存在了，自动改到第一个 enabled 实例
    const ids = Object.keys(providers);
    let nextDefault = config.provider.default;
    let nextFallback = config.provider.fallback;
    if (!providers[nextDefault]) nextDefault = ids[0] ?? nextDefault;
    if (!providers[nextFallback]) nextFallback = ids[1] ?? ids[0] ?? nextFallback;
    const finalConfig = {
      ...config,
      provider: { default: nextDefault, fallback: nextFallback },
    };
    await writeConfig(finalConfig, paths);
    await writeProvidersFile(providers, paths);
    const { token, generated } = ensureWebToken();
    if (generated || !webTokenInfo) {
      setWebTokenInfo({ token, path: webAuthFilePath() });
      setSavedTokenJustNow(generated);
    }
    setConfig(finalConfig);
    setBanner(`Saved · 已保存 ${paths.configFile} + ${paths.providersFile}`);
    setScreen("done");
  }

  async function runDetect(): Promise<void> {
    setScreen("detecting");
    setBanner("Detecting providers (~500ms)... · 正在探测可用 provider...");
    try {
      const found = await detectAllProviders({ timeoutMs: 500 });
      setDetectResults(found);
      let appliedCount = 0;
      if (found.length > 0) {
        setProviders((current) => {
          const next = cloneProviders(current);
          for (const d of found) {
            // 已存在同 type+baseUrl 实例就跳过
            const existing = Object.entries(next).find(
              ([, e]) => e.type === d.type && e.baseUrl === d.baseUrl
            );
            if (existing) continue;
            const id = nextInstanceId(d.type, next);
            next[id] = {
              type: d.type,
              enabled: true,
              baseUrl: d.baseUrl,
              ...(d.model ? { model: d.model } : {}),
              ...(d.envVar ? { apiKeyEnvVar: d.envVar } : {}),
              timeoutMs: TYPE_DEFAULTS[d.type].timeoutMs,
            };
            appliedCount += 1;
          }
          return next;
        });
      }
      const types = found.map((f) => `${f.type}(${f.source})`).join(", ") || "none";
      setBanner(`Detected: ${types} · added=${appliedCount}/${found.length}（已存在同 baseUrl 实例不重复）`);
    } catch (err) {
      setBanner(`Detect failed · 探测失败：${err instanceof Error ? err.message : String(err)}`);
    }
    setScreen("main");
  }

  function handleWebTokenAction(action: "ensure" | "regenerate"): void {
    const fp = webAuthFilePath();
    if (action === "ensure") {
      const { token, generated } = ensureWebToken(fp);
      setWebTokenInfo({ token, path: fp });
      setSavedTokenJustNow(generated);
      setBanner(generated ? `Generated · 已生成 web token，保存到 ${fp}` : `Loaded · 已读取现有 token: ${fp}`);
    } else {
      const fresh = generateWebToken();
      writeWebAuthFile(fresh, fp);
      setWebTokenInfo({ token: fresh.token, path: fp });
      setSavedTokenJustNow(true);
      setBanner(`Regenerated · 已重新生成 web token，保存到 ${fp}`);
    }
    setScreen("main");
  }

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text>CodeClaw Provider Config · Provider 配置向导</Text>
        <Text color="gray">
          mode: {mode} | Esc 返回 / back | Ctrl+C 退出 / exit
        </Text>
      </Box>

      <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
        <Text color="yellow">{banner}</Text>
      </Box>

      <Box borderStyle="round" paddingX={1} flexDirection="column" marginTop={1}>
        <Text>
          default={config.provider.default} | fallback={config.provider.fallback} | permission=
          {config.defaults.permissionMode}
        </Text>
        {instanceIds.map((id) => (
          <Text key={id}>{instanceSummary(id, providers[id])}</Text>
        ))}
      </Box>

      <Box borderStyle="round" paddingX={1} flexDirection="column" marginTop={1}>
        {screen === "main" ? (
          <>
            <Text>Main Menu · 主菜单</Text>
            <SelectInput
              items={mainItems}
              onSelect={(item) => {
                if (item.value === "instances") return setScreen("instances-list");
                if (item.value === "default") return setScreen("default");
                if (item.value === "fallback") return setScreen("fallback");
                if (item.value === "web-token") return setScreen("web-token");
                if (item.value === "detect") return void runDetect();
                if (item.value === "save") return void save();
                exit();
              }}
            />
          </>
        ) : null}

        {screen === "instances-list" ? (
          <>
            <Text>Instances · 实例列表 ({instanceIds.length})</Text>
            <SelectInput
              items={instanceListItems}
              onSelect={(item) => {
                if (item.value === "back") return setScreen("main");
                if (item.value === "add") return setScreen("pick-type-for-add");
                if (item.value.startsWith("edit:")) {
                  const id = item.value.slice("edit:".length);
                  setSelectedInstanceId(id);
                  setScreen("provider-menu");
                  return;
                }
              }}
            />
          </>
        ) : null}

        {screen === "pick-type-for-add" ? (
          <>
            <Text>Pick provider type · 选择 provider 类型</Text>
            <SelectInput
              items={typePickItems}
              onSelect={(item) => {
                const t = item.value as ProviderType;
                setPendingType(t);
                setPendingRename(false);
                setFieldValue(nextInstanceId(t, providers));
                setBanner(`Naming new instance (suggested: ${nextInstanceId(t, providers)}) · 命名新实例`);
                setScreen("name-input");
              }}
            />
          </>
        ) : null}

        {screen === "name-input" ? (
          <>
            <Text>
              {pendingRename
                ? `Rename instance · 重命名: ${selectedInstanceId} → ?`
                : `New instance id · 新实例 id (type=${pendingType ?? "?"})`}
            </Text>
            <Text color="gray">
              Allowed · 允许字符: a-zA-Z0-9 _ : . - · Enter=save · ESC=cancel
            </Text>
            <Box marginTop={1}>
              <Text color="cyan">{"> "}</Text>
              <SafeTextInput value={fieldValue} onChange={setFieldValue} onSubmit={submitNameInput} />
            </Box>
          </>
        ) : null}

        {screen === "web-token" ? (
          <>
            <Text>Web token · Web 鉴权令牌 · ~/.codeclaw/web-auth.json</Text>
            {webTokenInfo ? (
              <Text color="gray">
                Current · 当前: {maskToken(webTokenInfo.token)}（path/路径: {webTokenInfo.path}）
              </Text>
            ) : (
              <Text color="gray">Not generated yet · 尚未生成；首次启动 codeclaw web 也会自动生成</Text>
            )}
            <SelectInput
              items={webTokenMenuItems}
              onSelect={(item) => {
                if (item.value === "back") return setScreen("main");
                handleWebTokenAction(item.value as "ensure" | "regenerate");
              }}
            />
          </>
        ) : null}

        {screen === "detecting" ? (
          <Box flexDirection="column">
            <Text color="cyan">Detecting providers... · 正在探测可用 provider...</Text>
            <Text color="gray">probing localhost:1234 / localhost:11434 + scanning env keys (~500ms)</Text>
            {detectResults.length > 0 ? (
              <Box marginTop={1} flexDirection="column">
                <Text color="green">Last results · 上次探测结果 ({detectResults.length}):</Text>
                {detectResults.map((d, i) => (
                  <Text key={i} color="gray">
                    · {d.type} ({d.source}) baseUrl={d.baseUrl}
                    {d.model ? ` model=${d.model}` : ""}
                    {d.envVar ? ` env=${d.envVar}` : ""}
                  </Text>
                ))}
              </Box>
            ) : null}
          </Box>
        ) : null}

        {screen === "default" ? (
          <>
            <Text>Select default instance · 选择默认实例</Text>
            <SelectInput
              items={instanceSelectItems}
              onSelect={(item) => {
                setConfig((current) => ({ ...current, provider: { ...current.provider, default: item.value } }));
                setBanner(`Default instance set to ${item.value} · 默认实例已设为 ${item.value}`);
                setScreen("main");
              }}
            />
          </>
        ) : null}

        {screen === "fallback" ? (
          <>
            <Text>Select fallback instance · 选择备用实例</Text>
            <SelectInput
              items={instanceSelectItems}
              onSelect={(item) => {
                setConfig((current) => ({ ...current, provider: { ...current.provider, fallback: item.value } }));
                setBanner(`Fallback instance set to ${item.value} · 备用实例已设为 ${item.value}`);
                setScreen("main");
              }}
            />
          </>
        ) : null}

        {screen === "provider-menu" ? (
          <>
            <Text>
              Edit instance · 编辑: {selectedInstanceId}
              {selectedEntry ? ` (type=${selectedEntry.type})` : " (deleted)"}
            </Text>
            <SelectInput
              items={providerMenuItems}
              onSelect={(item) => {
                if (item.value === "back") return setScreen("instances-list");
                startFieldEdit(item.value as EditableField);
              }}
            />
          </>
        ) : null}

        {screen === "field-input" ? (
          <>
            <Text>
              Edit · 编辑 {selectedInstanceId}.{selectedField}
            </Text>
            <Text color="gray">
              {selectedField === "timeoutMs" || selectedField === "maxTokens" || selectedField === "contextWindow"
                ? "Positive integer or blank to clear · 正整数；留空清空。Enter=save · ESC=cancel · Ctrl+C=exit."
                : "Backspace/←→ edit · Ctrl+A=home Ctrl+E=end Ctrl+U=clear Ctrl+W=del-word · Enter=save · ESC=cancel."}
            </Text>
            <Text color="gray">buffer length · 缓冲长度: {fieldValue.length}</Text>
            <Box marginTop={1}>
              <Text color="cyan">{"> "}</Text>
              <SafeTextInput value={fieldValue} onChange={setFieldValue} onSubmit={submitField} />
            </Box>
          </>
        ) : null}

        {screen === "done" ? (
          <>
            <Text color="green">Configuration saved. · 配置已保存。</Text>
            {webTokenInfo ? (
              <>
                <Text color="cyan">
                  Web token: {savedTokenJustNow ? webTokenInfo.token : maskToken(webTokenInfo.token)}
                </Text>
                <Text color="gray">
                  {savedTokenJustNow
                    ? `Saved to · 已保存到 ${webTokenInfo.path}（mode 0600，请复制保存）`
                    : `Path · 路径: ${webTokenInfo.path}`}
                </Text>
              </>
            ) : null}
            <Text>Press Ctrl+C to exit. · 按 Ctrl+C 退出。</Text>
          </>
        ) : null}
      </Box>
    </Box>
  );
}
