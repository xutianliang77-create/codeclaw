import React from "react";
import { render } from "ink";
import { createQueryEngine } from "./agent/queryEngine";
import { App } from "./app/App";
import { ProviderConfigApp } from "./app/ProviderConfigApp";
import { loadConfigCommandState } from "./commands/config";
import { runDoctor } from "./commands/doctor";
import { loadSetupCommandState } from "./commands/setup";
import { IngressGateway } from "./ingress/gateway";
import { resolveConfigPaths } from "./lib/config";
import { loadRuntimeSelection } from "./provider/registry";
import { runPlainRepl } from "./repl/plain";
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
  const queryEngine = createQueryEngine({
    currentProvider: runtime.selection?.current ?? null,
    fallbackProvider: runtime.selection?.fallback ?? null,
    permissionMode: runtime.config?.defaults.permissionMode ?? "plan",
    workspace: runtime.config?.defaults.workspace ?? process.cwd(),
    autoCompactThreshold: runtime.config?.memory.l1AutoCompactThreshold,
    approvalsDir: paths.approvalsDir
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

  if (usePlainRepl || command === "plain") {
    await runPlainRepl({
      bootInfo: {
        providerLabel: runtime.selection?.current?.displayName ?? "not-configured",
        modelLabel: runtime.selection?.current?.model ?? "scaffold",
        providerReason: runtime.selection?.current?.reason ?? "run `codeclaw setup` to initialize providers",
        permissionMode: runtime.config?.defaults.permissionMode ?? "plan",
        workspace: runtime.config?.defaults.workspace ?? process.cwd()
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
        workspace: runtime.config?.defaults.workspace ?? process.cwd()
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
