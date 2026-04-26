import React from "react";
import { render } from "ink";
import { createQueryEngine } from "./agent/queryEngine";
import { App } from "./app/App";
import { ProviderConfigApp } from "./app/ProviderConfigApp";
import { loadConfigCommandState } from "./commands/config";
import { runDoctor } from "./commands/doctor";
import { loadSetupCommandState } from "./commands/setup";
import { createWechatBotService } from "./channels/wechat/service";
import { IngressGateway } from "./ingress/gateway";
import { createDefaultConfig, resolveConfigPaths } from "./lib/config";
import { detectProviderCapabilities } from "./provider/capabilities";
import { createOpenAiCompatibleSpeechTranscriber } from "./provider/speech";
import { loadRuntimeSelection } from "./provider/registry";
import { runPlainRepl } from "./repl/plain";
import { McpManager } from "./mcp/manager";
import { loadMcpConfig } from "./mcp/config";
import { loadSettings } from "./hooks/settings";
import { startGatewayServer } from "./sdk/httpServer";
import { VERSION } from "./version";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function printHelp(): void {
  console.log(`CodeClaw ${VERSION}

Usage:
  codeclaw                 Start the scaffolded CLI
  codeclaw --plain         Start the plain-text REPL (IME-safe fallback)
  codeclaw --version       Print version
  codeclaw --help          Print help
  codeclaw doctor          Show environment diagnostics
  codeclaw setup           Open interactive first-run setup
  codeclaw config          Open interactive provider config
  codeclaw gateway         Start the local HTTP gateway
  codeclaw wechat          Start the local WeChat adapter webhook
  codeclaw wechat --worker Start the iLink WeChat polling worker
  codeclaw web             Start the Web SPA server (env CODECLAW_WEB_TOKEN required)
                           Optional: --port=7180 --host=127.0.0.1
`);
}

function installCrashLogging(logsDir: string): void {
  const crashLogFile = path.join(logsDir, "crash.log");
  mkdirSync(logsDir, { recursive: true });

  const log = (label: string, error: unknown) => {
    const body = error instanceof Error ? error.stack ?? error.message : String(error);
    appendFileSync(crashLogFile, `[${new Date().toISOString()}] ${label}\n${body}\n\n`, "utf8");
  };

  process.on("uncaughtException", (error) => {
    log("uncaughtException", error);
  });

  process.on("unhandledRejection", (error) => {
    log("unhandledRejection", error);
  });
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const usePlainRepl = rawArgs.includes("--plain");
  const filteredArgs = rawArgs.filter((arg) => arg !== "--plain");
  const [command, ...restArgs] = filteredArgs;

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  if (command === "doctor") {
    console.log(await runDoctor());
    return;
  }

  if (command === "skill") {
    const { runSkillSubcommand } = await import("./cli/skill-cli");
    process.exit(runSkillSubcommand(restArgs));
  }

  if (command === "web") {
    const { startWebServer } = await import("./channels/web/server");
    const { readWebAuthConfig } = await import("./channels/web/auth");
    const auth = readWebAuthConfig();
    if (!auth.bearerToken) {
      console.error(
        "[web] CODECLAW_WEB_TOKEN is not set. Set the env var to a strong\n" +
          "       token and re-run. The Web channel REQUIRES auth to start."
      );
      process.exit(2);
    }
    const portArg = restArgs.find((a) => a.startsWith("--port="))?.split("=")[1];
    const hostArg = restArgs.find((a) => a.startsWith("--host="))?.split("=")[1];
    const port = portArg ? Number(portArg) : 7180;
    const host = hostArg ?? "127.0.0.1";
    const handle = await startWebServer({
      port,
      host,
      auth,
      engineDefaults: {
        currentProvider: null,
        fallbackProvider: null,
        permissionMode: "plan",
        workspace: process.cwd(),
      },
    });
    console.log(`CodeClaw Web listening on http://${handle.host}:${handle.port}`);
    console.log("Open it in your browser. Set the same CODECLAW_WEB_TOKEN value in the auth bar.");
    process.on("SIGINT", () => {
      void handle.close().finally(() => process.exit(0));
    });
    return;
  }

  if (command === "setup") {
    const state = await loadSetupCommandState();
    render(
      <ProviderConfigApp
        initialConfig={state.config}
        initialProviders={state.providers}
        paths={state.paths}
        mode="setup"
      />,
      {
        exitOnCtrlC: false
      }
    );
    return;
  }

  if (command === "config") {
    const state = await loadConfigCommandState();
    render(
      <ProviderConfigApp
        initialConfig={state.config}
        initialProviders={state.providers}
        paths={state.paths}
        mode="config"
      />,
      {
        exitOnCtrlC: false
      }
    );
    return;
  }

  const runtime = await loadRuntimeSelection();
  const paths = resolveConfigPaths();
  installCrashLogging(paths.logsDir);
  const configDefaults = createDefaultConfig(runtime.config?.defaults.workspace ?? process.cwd());
  const configuredWechatTokenFile =
    runtime.config?.gateway?.bots?.ilinkWechat?.tokenFile ??
    configDefaults.gateway?.bots?.ilinkWechat?.tokenFile ??
    process.env.CODECLAW_ILINK_WECHAT_TOKEN_FILE;
  const configuredWechatBaseUrl =
    runtime.config?.gateway?.bots?.ilinkWechat?.baseUrl ??
    configDefaults.gateway?.bots?.ilinkWechat?.baseUrl ??
    process.env.CODECLAW_ILINK_WECHAT_BASE_URL ??
    "https://ilinkai.weixin.qq.com";
  const configuredSpeechAsr = runtime.config?.speech?.asr;
  const speechApiKeyEnvVar = configuredSpeechAsr?.apiKeyEnvVar;
  const speechApiKey = speechApiKeyEnvVar ? process.env[speechApiKeyEnvVar] : undefined;
  const speechTranscriber =
    configuredSpeechAsr?.enabled
      ? createOpenAiCompatibleSpeechTranscriber({
          baseUrl: configuredSpeechAsr.baseUrl ?? "http://127.0.0.1:1234/v1",
          model: configuredSpeechAsr.model ?? "whisper-1",
          timeoutMs: configuredSpeechAsr.timeoutMs ?? 60_000,
          apiKey: speechApiKey,
          language: configuredSpeechAsr.language,
          prompt: configuredSpeechAsr.prompt
        })
      : undefined;
  const wechatService = createWechatBotService({
    createQueryEngine(overrides) {
      return createQueryEngine({
        currentProvider: runtime.selection?.current ?? null,
        fallbackProvider: runtime.selection?.fallback ?? null,
        permissionMode: runtime.config?.defaults.permissionMode ?? "plan",
        workspace: runtime.config?.defaults.workspace ?? process.cwd(),
        autoCompactThreshold: runtime.config?.memory.l1AutoCompactThreshold,
        approvalsDir: paths.approvalsDir,
        ...overrides
      });
    },
    transcribeAudio: speechTranscriber
  });
  let autoWechatWorkerPromise: Promise<void> | null = null;
  let autoWechatWorkerStarted = false;
  const ensureAutoWechatWorkerStarted = async (): Promise<void> => {
    if (autoWechatWorkerStarted || autoWechatWorkerPromise) {
      return;
    }

    const tokenFile = configuredWechatTokenFile;
    if (!tokenFile) {
      return;
    }

    const worker = wechatService.createWorker({
      tokenFile,
      baseUrl: configuredWechatBaseUrl,
      pollIntervalMs:
        runtime.config?.gateway?.bots?.ilinkWechat?.pollIntervalMs ??
        configDefaults.gateway?.bots?.ilinkWechat?.pollIntervalMs ??
        (process.env.CODECLAW_ILINK_WECHAT_POLL_INTERVAL_MS
          ? Number.parseInt(process.env.CODECLAW_ILINK_WECHAT_POLL_INTERVAL_MS, 10)
          : undefined)
    });

    autoWechatWorkerPromise = worker
      .run()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        console.error(`CodeClaw wechat auto-worker failed:\n${message}`);
      })
      .finally(() => {
        autoWechatWorkerStarted = false;
        autoWechatWorkerPromise = null;
      });
    autoWechatWorkerStarted = true;
    console.log("CodeClaw wechat auto-worker started");
  };
  const wechatLoginManager = configuredWechatTokenFile
    ? wechatService.createLoginManager({
        tokenFile: configuredWechatTokenFile,
        baseUrl: configuredWechatBaseUrl,
        onConfirmed: async () => {
          await ensureAutoWechatWorkerStarted();
        }
      })
    : undefined;
  // M3-01：启动 MCP manager（spawn ~/.codeclaw/mcp.json 或项目级 .mcp.json 中的所有
  // enabled server），失败 server 不阻塞主进程；找不到配置就是空 manager（无 spawn）
  const workspace = runtime.config?.defaults.workspace ?? process.cwd();
  const mcpManager = new McpManager();
  try {
    await mcpManager.start(loadMcpConfig(workspace));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`CodeClaw MCP manager startup failed (continuing without spawn servers): ${msg}`);
  }
  process.on("exit", () => {
    void mcpManager.closeAll().catch(() => undefined);
  });

  // M3-04：加载 settings.json（hooks + statusLine 配置）；解析失败不阻塞主进程
  let settings;
  try {
    settings = loadSettings(workspace);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`CodeClaw settings load failed (continuing without hooks): ${msg}`);
    settings = undefined;
  }

  const queryEngine = createQueryEngine({
    currentProvider: runtime.selection?.current ?? null,
    fallbackProvider: runtime.selection?.fallback ?? null,
    permissionMode: runtime.config?.defaults.permissionMode ?? "plan",
    workspace,
    autoCompactThreshold: runtime.config?.memory.l1AutoCompactThreshold,
    approvalsDir: paths.approvalsDir,
    mcpManager,
    settings,
    wechat: {
      tokenFile: configuredWechatTokenFile,
      baseUrl: configuredWechatBaseUrl,
      attachCurrentSession: () => {
        wechatService.attachSharedRuntime(queryEngine);
      },
      loginManager: wechatLoginManager
    }
  });
  const ingressGateway = new IngressGateway(queryEngine);

  if (command === "gateway") {
    const portFlagIndex = restArgs.findIndex((arg) => arg === "--port");
    const parsedPort =
      portFlagIndex >= 0 && restArgs[portFlagIndex + 1]
        ? Number.parseInt(restArgs[portFlagIndex + 1] ?? "", 10)
        : Number.NaN;
    const port = Number.isFinite(parsedPort) ? parsedPort : 3000;
    const authToken = process.env.CODECLAW_GATEWAY_TOKEN ?? null;
    await startGatewayServer({
      ingressGateway,
      queryEngine,
      port,
      authToken
    });
    console.log(`CodeClaw gateway listening on http://127.0.0.1:${port}`);
    if (authToken) {
      console.log("Gateway auth: bearer token enabled");
    }
    return;
  }

  if (command === "wechat") {
    const runWorker = restArgs.includes("--worker");
    const portFlagIndex = restArgs.findIndex((arg) => arg === "--port");
    const parsedPort =
      portFlagIndex >= 0 && restArgs[portFlagIndex + 1]
        ? Number.parseInt(restArgs[portFlagIndex + 1] ?? "", 10)
        : Number.NaN;
    const port = Number.isFinite(parsedPort) ? parsedPort : 3100;
    const authToken = process.env.CODECLAW_WECHAT_TOKEN ?? null;
    if (runWorker) {
      const tokenFile = configuredWechatTokenFile;
      if (!tokenFile) {
        throw new Error(
          "iLink WeChat worker requires gateway.bots.ilinkWechat.tokenFile or CODECLAW_ILINK_WECHAT_TOKEN_FILE"
        );
      }

      const worker = wechatService.createWorker({
        tokenFile,
        baseUrl: configuredWechatBaseUrl,
        pollIntervalMs:
          runtime.config?.gateway?.bots?.ilinkWechat?.pollIntervalMs ??
          configDefaults.gateway?.bots?.ilinkWechat?.pollIntervalMs ??
          (process.env.CODECLAW_ILINK_WECHAT_POLL_INTERVAL_MS
            ? Number.parseInt(process.env.CODECLAW_ILINK_WECHAT_POLL_INTERVAL_MS, 10)
            : undefined)
      });

      console.log("CodeClaw wechat worker started");
      await worker.run();
      return;
    }

    await wechatService.start({
      port,
      authToken
    });
    console.log(`CodeClaw wechat adapter listening on http://127.0.0.1:${port}`);
    if (authToken) {
      console.log("WeChat adapter auth: bearer token enabled");
    }
    return;
  }

  const capabilities = detectProviderCapabilities(runtime.selection?.current ?? null);

  if (usePlainRepl || command === "plain") {
    await runPlainRepl({
      bootInfo: {
        providerLabel: runtime.selection?.current?.displayName ?? "not-configured",
        modelLabel: runtime.selection?.current?.model ?? "scaffold",
        providerReason: runtime.selection?.current?.reason ?? "run `codeclaw setup` to initialize providers",
        permissionMode: runtime.config?.defaults.permissionMode ?? "plan",
        workspace: runtime.config?.defaults.workspace ?? process.cwd(),
        visionSupport: capabilities.vision
      },
      queryEngine,
      ingressGateway
    });
    return;
  }

  render(
    <App
      bootInfo={{
        providerLabel: runtime.selection?.current?.displayName ?? "not-configured",
        modelLabel: runtime.selection?.current?.model ?? "scaffold",
        providerReason: runtime.selection?.current?.reason ?? "run `codeclaw setup` to initialize providers",
        permissionMode: runtime.config?.defaults.permissionMode ?? "plan",
        workspace: runtime.config?.defaults.workspace ?? process.cwd(),
        visionSupport: capabilities.vision
      }}
      queryEngine={queryEngine}
      ingressGateway={ingressGateway}
    />,
    {
      exitOnCtrlC: false
    }
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
