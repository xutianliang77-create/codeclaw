import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { EngineMessage, EnginePhase, PendingApprovalView, QueryEngine } from "../agent/types";
import { createCliIngressMessage } from "../channels/cli/adapter";
import type { IngressGateway } from "../ingress/gateway";
import { feature } from "../lib/feature";

type AppBootInfo = {
  providerLabel: string;
  modelLabel: string;
  providerReason: string;
  permissionMode: string;
  workspace: string;
  visionSupport: "supported" | "unsupported" | "unknown";
};

type PendingApprovalState = PendingApprovalView | null;

function formatTurnError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function Header({
  bootInfo,
  sessionId
}: {
  bootInfo: AppBootInfo;
  sessionId: string;
}): React.JSX.Element {
  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Text>
        CodeClaw  session: {sessionId}  model: {bootInfo.modelLabel}  mode: {bootInfo.permissionMode}  cwd:{" "}
        {bootInfo.workspace}
      </Text>
      <Text color="gray">
        provider: {bootInfo.providerLabel}  vision: {bootInfo.visionSupport}  token-budget: {feature("TOKEN_BUDGET") ? "enabled" : "disabled"}
      </Text>
    </Box>
  );
}

function TranscriptPane({ messages }: { messages: EngineMessage[] }): React.JSX.Element {
  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column" marginTop={1}>
      {messages.map((message, index) => (
        <Box key={message.id || `${message.role}-${index}`} marginBottom={1} flexDirection="column">
          <Text color={message.role === "user" ? "cyan" : message.role === "assistant" ? "green" : "yellow"}>
            {message.role.toUpperCase()}
          </Text>
          <Text>{message.text}</Text>
        </Box>
      ))}
    </Box>
  );
}

function StatusBar({
  phase,
  toolStatus
}: {
  phase: string;
  toolStatus: string | null;
}): React.JSX.Element {
  return (
    <Box borderStyle="round" paddingX={1} marginTop={1} flexDirection="column">
      <Text>phase: {phase}</Text>
      {toolStatus ? <Text color="gray">tool: {toolStatus}</Text> : null}
    </Box>
  );
}

function ApprovalPanel({ pendingApproval }: { pendingApproval: PendingApprovalState }): React.JSX.Element | null {
  if (!pendingApproval) {
    return null;
  }

  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1} flexDirection="column">
      <Text color="yellow">
        Approval Pending {pendingApproval.totalPending > 1 ? `(${pendingApproval.queuePosition}/${pendingApproval.totalPending})` : ""}
      </Text>
      <Text>id: {pendingApproval.id}</Text>
      <Text>tool: {pendingApproval.toolName}</Text>
      <Text>detail: {pendingApproval.detail}</Text>
      <Text>reason: {pendingApproval.reason}</Text>
      <Text color="gray">Use `/approve`, `/deny`, or target a specific item with `/approve &lt;id&gt;`.</Text>
    </Box>
  );
}

function FooterHints(): React.JSX.Element {
  return (
    <Box borderStyle="round" paddingX={1} marginTop={1}>
      <Text color="gray">Enter send  Ctrl+C interrupt  Esc clear banner  Try: /help  /status  /approvals  /mode auto  /glob src/**/*.ts  /approve  /approve &lt;id&gt;  /exit</Text>
    </Box>
  );
}

export function App({
  bootInfo,
  queryEngine,
  ingressGateway
}: {
  bootInfo: AppBootInfo;
  queryEngine: QueryEngine;
  ingressGateway: IngressGateway;
}): React.JSX.Element {
  const { exit } = useApp();
  const initialRuntimeState = queryEngine.getRuntimeState();
  const initialPendingApproval = queryEngine.getPendingApproval();
  const [phase, setPhase] = useState<EnginePhase>("idle");
  const [input, setInput] = useState("");
  const [banner, setBanner] = useState<string | null>(bootInfo.providerReason);
  const [runtimeState, setRuntimeState] = useState(initialRuntimeState);
  const [messages, setMessages] = useState<EngineMessage[]>(queryEngine.getMessages());
  const [isRunning, setIsRunning] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(
    initialPendingApproval
      ? `${initialPendingApproval.toolName} pending approval (${initialPendingApproval.totalPending})`
      : null
  );
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalState>(initialPendingApproval);

  useEffect(() => {
    return queryEngine.subscribe(() => {
      setRuntimeState(queryEngine.getRuntimeState());
      setMessages(queryEngine.getMessages());
      setPendingApproval(queryEngine.getPendingApproval());
    });
  }, [queryEngine]);

  useInput((value, key) => {
    if (key.escape) {
      setBanner(null);
    }

    if (key.ctrl && value === "c") {
      if (isRunning) {
        ingressGateway.handleInterrupt(queryEngine.getSessionId());
        setBanner("Interrupt requested. Waiting for current turn to stop.");
        return;
      }

      exit();
    }

    if (pendingApproval && !isRunning && !input) {
      if (value === "a") {
        void handleSubmit("/approve");
      }

      if (value === "d") {
        void handleSubmit("/deny");
      }
    }
  });

  async function handleSubmit(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed || isRunning) {
      return;
    }

    if (trimmed === "/exit") {
      exit();
      return;
    }

    setInput("");
    setIsRunning(true);

    const stream = ingressGateway.handleMessage(
      createCliIngressMessage(trimmed, {
        userId: "local-user",
        sessionId: queryEngine.getSessionId(),
        workspace: bootInfo.workspace
      })
    );
    setMessages(queryEngine.getMessages());
    let turnErrorMessage: string | null = null;

    try {
      for await (const envelope of stream) {
        const event = envelope.payload;
        if (event.type === "phase") {
          setPhase(event.phase);
          if (event.phase === "halted") {
            setBanner("Turn halted by interrupt.");
          }
          continue;
        }

        if (event.type === "approval-request") {
          setPendingApproval({
            id: event.approvalId,
            toolName: event.toolName,
            detail: event.detail,
            reason: event.reason,
            queuePosition: event.queuePosition,
            totalPending: event.totalPending
          });
          setToolStatus(`${event.toolName} pending approval (${event.totalPending})`);
          setBanner(
            event.totalPending > 1
              ? `${event.totalPending} approvals queued. Active: ${event.toolName}. Use /approve or /deny.`
              : `Approval required for ${event.toolName}. Use /approve or /deny.`
          );
          continue;
        }

        if (event.type === "approval-cleared") {
          const nextPendingApproval = queryEngine.getPendingApproval();
          setPendingApproval(nextPendingApproval);
          setBanner(nextPendingApproval ? `${nextPendingApproval.totalPending} approvals still queued.` : null);
          continue;
        }

        if (event.type === "tool-start") {
          setToolStatus(`${event.toolName} running`);
          continue;
        }

        if (event.type === "tool-end") {
          setToolStatus(`${event.toolName} ${event.status}`);
          continue;
        }

        if (event.type === "message-start") {
          setMessages((current) => [
            ...current,
            {
              id: event.messageId,
              role: event.role,
              text: ""
            }
          ]);
          continue;
        }

        if (event.type === "message-delta") {
          setMessages((current) =>
            current.map((message) =>
              message.id === event.messageId ? { ...message, text: message.text + event.delta } : message
            )
          );
          continue;
        }

        setMessages((current) =>
          current.map((message) =>
            message.id === event.messageId ? { ...message, text: event.text } : message
          )
        );
      }
    } catch (error) {
      turnErrorMessage = formatTurnError(error);
      setBanner(`Turn failed: ${turnErrorMessage}`);
      setPhase("halted");
      setToolStatus("failed");
    } finally {
      const nextPendingApproval = queryEngine.getPendingApproval();
      setPendingApproval(nextPendingApproval);
      setToolStatus(
        nextPendingApproval
          ? `${nextPendingApproval.toolName} pending approval (${nextPendingApproval.totalPending})`
          : toolStatus
      );
      setRuntimeState(queryEngine.getRuntimeState());
      const nextMessages = queryEngine.getMessages();
      setMessages(
        turnErrorMessage
          ? [
              ...nextMessages,
              {
                id: `error-${Date.now()}`,
                role: "assistant",
                text: `Turn failed: ${turnErrorMessage}`,
                source: "local"
              }
            ]
          : nextMessages
      );
      setIsRunning(false);
    }
  }

  return (
    <Box flexDirection="column">
      <Header
        bootInfo={{
          ...bootInfo,
          providerLabel: runtimeState.providerLabel,
          modelLabel: runtimeState.modelLabel,
          permissionMode: runtimeState.permissionMode
        }}
        sessionId={queryEngine.getSessionId()}
      />
      {banner ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
          <Text color="yellow">{banner}</Text>
        </Box>
      ) : null}
      <TranscriptPane messages={messages} />
      <StatusBar phase={phase} toolStatus={toolStatus} />
      <ApprovalPanel pendingApproval={pendingApproval} />
      <Box borderStyle="round" paddingX={1} marginTop={1}>
        <Text color="cyan">{"> "}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={(value) => {
            void handleSubmit(value);
          }}
        />
      </Box>
      <FooterHints />
    </Box>
  );
}
