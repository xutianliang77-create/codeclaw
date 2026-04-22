import { createInterface } from "node:readline/promises";
import process from "node:process";
import type { QueryEngine } from "../agent/types";
import { createCliIngressMessage } from "../channels/cli/adapter";
import type { IngressGateway } from "../ingress/gateway";

type PlainBootInfo = {
  providerLabel: string;
  modelLabel: string;
  providerReason: string;
  permissionMode: string;
  workspace: string;
};

function printLine(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function printBlock(title: string, body: string): void {
  printLine(`${title.toUpperCase()}`);
  printLine(body);
  printLine();
}

function printBoot(bootInfo: PlainBootInfo, sessionId: string): void {
  printLine(
    `CodeClaw  session: ${sessionId}  model: ${bootInfo.modelLabel}  mode: ${bootInfo.permissionMode}`
  );
  printLine(`cwd: ${bootInfo.workspace}`);
  printLine(`provider: ${bootInfo.providerLabel}`);
  printLine(bootInfo.providerReason);
  printLine();
}

export async function runPlainRepl(options: {
  bootInfo: PlainBootInfo;
  queryEngine: QueryEngine;
  ingressGateway: IngressGateway;
}): Promise<void> {
  const { bootInfo, queryEngine, ingressGateway } = options;
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });
  let isRunning = false;

  printBoot(bootInfo, queryEngine.getSessionId());

  for (const message of queryEngine.getMessages()) {
    printBlock(message.role, message.text);
  }

  readline.on("SIGINT", () => {
    if (isRunning) {
      ingressGateway.handleInterrupt(queryEngine.getSessionId());
      printLine();
      printLine("Interrupt requested. Waiting for current turn to stop.");
      return;
    }

    readline.close();
  });

  try {
    while (true) {
      const input = await readline.question("> ");
      const trimmed = input.trim();
      if (!trimmed) {
        continue;
      }

      if (trimmed === "/exit") {
        break;
      }

      printBlock("user", trimmed);
      isRunning = true;

      let assistantText = "";
      let turnFailed = false;

      try {
        const stream = ingressGateway.handleMessage(
          createCliIngressMessage(trimmed, {
            userId: "local-user",
            sessionId: queryEngine.getSessionId(),
            workspace: bootInfo.workspace
          })
        );

        for await (const envelope of stream) {
          const event = envelope.payload;
          if (event.type === "message-delta") {
            assistantText += event.delta;
            continue;
          }

          if (event.type === "message-complete") {
            assistantText = event.text;
            continue;
          }

          if (event.type === "approval-request") {
            printLine(
              `APPROVAL ${event.approvalId} ${event.toolName} ${event.detail} ${event.reason}`
            );
            continue;
          }

          if (event.type === "tool-start") {
            printLine(`TOOL ${event.toolName} running ${event.detail}`);
            continue;
          }

          if (event.type === "tool-end") {
            printLine(`TOOL ${event.toolName} ${event.status}`);
            continue;
          }

          if (event.type === "phase" && event.phase === "halted") {
            printLine("phase: halted");
          }
        }
      } catch (error) {
        turnFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        printBlock("assistant", `Turn failed: ${message}`);
      } finally {
        isRunning = false;
      }

      if (!turnFailed && assistantText) {
        printBlock("assistant", assistantText);
      }
    }
  } finally {
    readline.close();
  }
}
