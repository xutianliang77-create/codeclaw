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

/**
 * 启动前检测 better-sqlite3 native binding 是否能在当前平台加载
 * （v0.7.0 P1.3）。跨平台拷贝 node_modules 时常见 mach-o / ELF mismatch
 * 错误，原始堆栈 200+ 行不友好。这里给一个清晰指引并 exit。
 */
async function assertNativeDeps(): Promise<void> {
  try {
    // ESM 动态 import；触发 better-sqlite3 native bindings 实际加载（new Database 才走 bindings.js）
    const mod = (await import("better-sqlite3")) as unknown as {
      default: new (filename: string) => { close(): void };
    };
    const probe = new mod.default(":memory:");
    probe.close();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isCrossPlatform =
      /mach-o file|invalid ELF|wrong ELF class|Bad CPU type|incompatible architecture/i.test(msg);
    if (isCrossPlatform) {
      console.error(
        [
          "[startup] better-sqlite3 native module 平台不匹配（跨平台拷贝 node_modules 常见错误）。",
          "[startup] 修复：cd " + process.cwd() + " && npm rebuild better-sqlite3",
          "[startup] 或全部重装：rm -rf node_modules package-lock.json && npm install",
          "",
          "原始错误（前 1 行）: " + msg.split("\n")[0],
        ].join("\n")
      );
    } else {
      console.error(
        "[startup] 加载 better-sqlite3 失败：" + msg + "\n[startup] 尝试 `npm rebuild better-sqlite3`"
      );
    }
    process.exit(1);
  }
}

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

  // P1.3: 跨平台 native 模块自检；--version / --help 之后执行
  // （这两条短路命令不需要 DB，提前 return 不影响）
  await assertNativeDeps();

  if (command === "doctor") {
    console.log(await runDoctor());
    return;
  }

  if (command === "skill") {
    const { runSkillSubcommand } = await import("./cli/skill-cli");
    process.exit(runSkillSubcommand(restArgs));
  }

  // web 子命令需要 mcpManager / settings / runtime selection（A2 修补）；
  // 真正的 dispatch 在下方 settings 加载之后；这里只做 token 早期检查。
  if (command === "web") {
    const { readWebAuthConfig } = await import("./channels/web/auth");
    const auth = readWebAuthConfig();
    if (!auth.bearerToken) {
      console.error(
        "[web] CODECLAW_WEB_TOKEN is not set. Set the env var to a strong\n" +
          "       token and re-run. The Web channel REQUIRES auth to start."
      );
      process.exit(2);
    }
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
  // M3-01：MCP manager 启动 + 优雅关闭。先于 wechat / web / queryEngine 创建，
  // 让所有 channel 的 createQueryEngine factory 都能 capture mcpManager。
  // 失败 server 不阻塞主进程；找不到配置就是空 manager（无 spawn）。
  const workspace = runtime.config?.defaults.workspace ?? process.cwd();
  const mcpManager = new McpManager();
  try {
    await mcpManager.start(loadMcpConfig(workspace));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`CodeClaw MCP manager startup failed (continuing without spawn servers): ${msg}`);
  }
  // process.on("exit") 是同步事件，async closeAll 不会被等待 → 子进程变 zombie；
  // 改 SIGINT/SIGTERM/beforeExit（async-aware）。
  let mcpClosingPromise: Promise<void> | null = null;
  const shutdownMcp = async (): Promise<void> => {
    if (!mcpClosingPromise) {
      mcpClosingPromise = mcpManager.closeAll().catch(() => undefined);
    }
    return mcpClosingPromise;
  };
  process.on("beforeExit", () => {
    void shutdownMcp();
    queryEngineForShutdown?.disposeCron?.();
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      try {
        queryEngineForShutdown?.disposeCron?.();
      } catch {
        // 关 scheduler 不阻塞退出
      }
      void shutdownMcp().finally(() => process.exit(0));
    });
  }
  // queryEngine 在下方才创建；用 let 容纳后续赋值，闭包内引用。
  // 单独 Type cast 是为了避免循环引用 / partial type 报错。
  let queryEngineForShutdown: { disposeCron?: () => void } | null = null;

  // M3-04：加载 settings.json（hooks + statusLine 配置）；解析失败不阻塞主进程。
  // D1：支持 SIGHUP 触发热重载（settings 引用通过 reloadSettings 切换；queryEngine
  // 持有的旧引用不会自动跟进，需用 setHooksConfig 同步给现有 engine）。
  let settings = (() => {
    try {
      return loadSettings(workspace);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`CodeClaw settings load failed (continuing without hooks): ${msg}`);
      return undefined;
    }
  })();

  // A1：`codeclaw web` 子命令在此 dispatch；engineDefaults 已能 capture mcpManager + settings + 选定 provider。
  // 早期校验已在 setup 区块完成（CODECLAW_WEB_TOKEN 缺失则 process.exit）。
  if (command === "web") {
    const { startWebServer } = await import("./channels/web/server");
    const { readWebAuthConfig } = await import("./channels/web/auth");
    const auth = readWebAuthConfig();
    const portArg = restArgs.find((a) => a.startsWith("--port="))?.split("=")[1];
    const hostArg = restArgs.find((a) => a.startsWith("--host="))?.split("=")[1];
    const port = portArg ? Number(portArg) : 7180;
    const host = hostArg ?? "127.0.0.1";
    // cronHost 创建在 startWebServer 之后（chicken-egg：cronHost 需要 handle.store 做 broadcast，
    // server deps 又需要 cronManager）。用 lazy ref 解开循环：startWebServer 拿到 ref，
    // cronHost 创建后填充 cronHostRef，handler 调时取最新。
    let cronHostRef: ReturnType<typeof createQueryEngine> | null = null;
    const handle = await startWebServer({
      port,
      host,
      auth,
      mcpManager,
      cronManagerRef: () =>
        (cronHostRef as unknown as { getCronManager?: () => unknown })?.getCronManager?.() as
          | import("./cron/manager").CronManager
          | null
          | undefined,
      hooksConfigRef: () => settings?.hooks,
      engineDefaults: {
        currentProvider: runtime.selection?.current ?? null,
        fallbackProvider: runtime.selection?.fallback ?? null,
        permissionMode: runtime.config?.defaults.permissionMode ?? "plan",
        workspace,
        approvalsDir: paths.approvalsDir,
        ...(runtime.config?.memory.l1AutoCompactThreshold !== undefined
          ? { autoCompactThreshold: runtime.config.memory.l1AutoCompactThreshold }
          : {}),
        mcpManager,
        settings,
      },
    });
    console.log(`CodeClaw Web listening on http://${handle.host}:${handle.port}`);
    console.log("Open it in your browser. Set the same CODECLAW_WEB_TOKEN value in the auth bar.");

    // 阶段 🅑：在 web 子命令也跑 cron。每个 user engine 的 channel="http" 会禁用 cron（避免重复触发）；
    // 这里独建 host engine（channel undefined → 走 cli 路径启 scheduler）专跑 cron + 广播 web SSE。
    const cronHost = cronHostRef = createQueryEngine({
      currentProvider: runtime.selection?.current ?? null,
      fallbackProvider: runtime.selection?.fallback ?? null,
      permissionMode: runtime.config?.defaults.permissionMode ?? "plan",
      workspace,
      auditDbPath: null,
      dataDbPath: null,
      ...(runtime.config?.memory.l1AutoCompactThreshold !== undefined
        ? { autoCompactThreshold: runtime.config.memory.l1AutoCompactThreshold }
        : {}),
      mcpManager,
      settings,
    });
    (cronHost as unknown as {
      setCronNotifyAdapters?: (a: {
        wechat?: (...args: unknown[]) => void;
        web?: (task: unknown, run: unknown) => void;
      }) => void;
    }).setCronNotifyAdapters?.({
      web: (task, run) => {
        handle.store.broadcastEvent({
          type: "cron-result",
          task,
          run,
        });
      },
    });

    // SIGHUP 同步 settings 到所有已有 web sessions
    process.on("SIGHUP", () => {
      try {
        const next = loadSettings(workspace);
        settings = next;
        handle.broadcastSettingsReload(next);
        console.log("CodeClaw web settings reloaded (SIGHUP)");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`CodeClaw web settings reload failed: ${msg}`);
      }
    });
    process.on("SIGINT", () => {
      try {
        (cronHost as unknown as { disposeCron?: () => void }).disposeCron?.();
      } catch {
        // 忽略
      }
      void handle.close().then(() => shutdownMcp()).finally(() => process.exit(0));
    });
    return;
  }

  // A2：wechat / web 共用同一组 mcpManager + settings；factory 闭包延迟 capture，
  // 每次 wechat 收到消息派生新 engine 时都注入这两个字段。
  const wechatService = createWechatBotService({
    createQueryEngine(overrides) {
      return createQueryEngine({
        currentProvider: runtime.selection?.current ?? null,
        fallbackProvider: runtime.selection?.fallback ?? null,
        permissionMode: runtime.config?.defaults.permissionMode ?? "plan",
        workspace,
        autoCompactThreshold: runtime.config?.memory.l1AutoCompactThreshold,
        approvalsDir: paths.approvalsDir,
        mcpManager,
        settings,
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
  queryEngineForShutdown = queryEngine as unknown as { disposeCron?: () => void };
  // #116 阶段 🅑：cron --notify=wechat 桥接到 wechatService 外发队列
  //   - 仅 worker 模式真生效（需要 wechat 长轮询通道；webhook 模式无 poll → 队列等用户下次说话才被触发）
  //   - 没有 active 接收方时（用户从未发过消息）静默丢弃 + console.warn
  (queryEngine as unknown as {
    setCronNotifyAdapters?: (a: {
      wechat?: (text: string) => void;
      web?: (...args: unknown[]) => void;
    }) => void;
  }).setCronNotifyAdapters?.({
    wechat: (text) => {
      const ok = wechatService.sendToActive(text);
      if (!ok) {
        console.warn("[cron] wechat notify dropped: no active wechat session yet");
      }
    },
  });
  const ingressGateway = new IngressGateway(queryEngine);

  // D1: SIGHUP 触发 settings 热重载（hooks + statusLine）。
  // queryEngine 已暴露 setHooksConfig；wechat factory 闭包用 'settings' 变量在每个
  // 后续 spawn 的 engine 自动 capture 新值（settings 改 let 引用即可）。
  process.on("SIGHUP", () => {
    try {
      const next = loadSettings(workspace);
      settings = next;
      queryEngine.setHooksConfig?.(next.hooks);
      console.log("CodeClaw settings reloaded (SIGHUP)");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`CodeClaw settings reload failed (keeping previous config): ${msg}`);
    }
  });

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
      statusLine={settings?.statusLine}
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
