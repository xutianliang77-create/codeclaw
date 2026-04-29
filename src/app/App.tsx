import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { SafeTextInput } from "./SafeTextInput";
import type { EngineMessage, EnginePhase, PendingApprovalView, QueryEngine } from "../agent/types";
import { createCliIngressMessage } from "../channels/cli/adapter";
import type { IngressGateway } from "../ingress/gateway";
import { sanitizeForDisplay } from "../lib/displaySafe";
import { feature } from "../lib/feature";
import { buildDefaultStatusLine, startCustomStatusLine } from "../hooks/statusLine";
import { frameScheduler } from "./frameScheduler";
import { stripThinking } from "../lib/stripThinking";

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
        CodeClaw · 会话 session: {sessionId} · 模型 model: {bootInfo.modelLabel} · 模式 mode:{" "}
        {bootInfo.permissionMode} · 工作区 cwd: {bootInfo.workspace}
      </Text>
      <Text color="gray">
        provider: {bootInfo.providerLabel}  vision · 视觉: {bootInfo.visionSupport}  token-budget · 预算:{" "}
        {feature("TOKEN_BUDGET") ? "enabled · 启用" : "disabled · 关闭"}
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
      <Text>phase · 阶段: {phase}</Text>
      {toolStatus ? <Text color="gray">tool · 工具: {toolStatus}</Text> : null}
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
        Approval Pending · 等待审批 {pendingApproval.totalPending > 1 ? `(${pendingApproval.queuePosition}/${pendingApproval.totalPending})` : ""}
      </Text>
      <Text>id · 编号: {pendingApproval.id}</Text>
      <Text>tool · 工具: {pendingApproval.toolName}</Text>
      <Text>detail · 详情: {sanitizeForDisplay(pendingApproval.detail)}</Text>
      <Text>reason · 原因: {sanitizeForDisplay(pendingApproval.reason)}</Text>
      <Text color="gray">
        Use `/approve` / `/deny` · 用 /approve 同意 / /deny 拒绝；或针对单个用 `/approve &lt;id&gt;`。
      </Text>
    </Box>
  );
}

function FooterHints(): React.JSX.Element {
  return (
    <Box borderStyle="round" paddingX={1} marginTop={1}>
      <Text color="gray">
        Enter 发送 send · Ctrl+C 中断 interrupt · Esc 清 banner · 试试: /help /status /approvals /mode auto /exit
      </Text>
    </Box>
  );
}

function StatusLine({ text }: { text: string }): React.JSX.Element {
  return (
    <Box paddingX={1}>
      <Text color="cyan">{text}</Text>
    </Box>
  );
}

// v0.8.5：默认 LLM 流式输出沉默（仅显示状态行，message-complete 才推完整 text）；
// CODECLAW_STREAM_OUTPUT=1 退路保留 v0.8.4 newline-gated 流式行为给老用户。
const STREAM_OUTPUT_ENABLED = process.env.CODECLAW_STREAM_OUTPUT === "1";

export function App({
  bootInfo,
  queryEngine,
  ingressGateway,
  statusLine,
  showThinking
}: {
  bootInfo: AppBootInfo;
  queryEngine: QueryEngine;
  ingressGateway: IngressGateway;
  /** M3-04 step 5：来自 settings.json statusLine 配置；省略走默认数据源 */
  statusLine?: { command?: string; intervalMs?: number };
  /** v0.8.5：--show-thinking flag / CODECLAW_SHOW_THINKING=1 → 保留 <think> 块原文 */
  showThinking?: boolean;
}): React.JSX.Element {
  const { exit } = useApp();
  const initialRuntimeState = queryEngine.getRuntimeState();
  const initialPendingApproval = queryEngine.getPendingApproval();
  const [phase, setPhase] = useState<EnginePhase>("idle");
  const [input, setInput] = useState("");
  const [banner, setBanner] = useState<string | null>(bootInfo.providerReason);
  const [runtimeState, setRuntimeState] = useState(initialRuntimeState);
  const [messages, setMessages] = useState<EngineMessage[]>(queryEngine.getVisibleMessages());
  const [isRunning, setIsRunning] = useState(false);
  // P4.1（v0.7.0）：Mac+ink 5 单次 Enter 触发多个 useInput callback 同 React tick 内执行；
  // useState 守卫是异步 schedule，所有 callback 看到 isRunning=false 全通过 → 双发。
  // useRef 同步 mark 防止：第二次进入 handleSubmit 立刻看到 true → return。
  const isRunningRef = useRef(false);
  // v0.8.4 newline-gated commit：流式 message-delta 累积到 partial / pendingCommit buffer，
  // 仅含换行的部分推到 messages.text，其余仅累积不触发 setState。参考 codex
  // streaming/controller.rs:push_delta —— "delta 含 \n 才 commit"。partial 不显示给用户，
  // 与 codex 行为对齐（避免每 token re-render 把 pty buffer 灌爆）。
  const partialBuf = useRef(new Map<string, string>());
  const pendingCommitBuf = useRef(new Map<string, string>());
  const [toolStatus, setToolStatus] = useState<string | null>(
    initialPendingApproval
      ? `${initialPendingApproval.toolName} pending approval (${initialPendingApproval.totalPending})`
      : null
  );
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalState>(initialPendingApproval);

  // M3-04 step 4+5：status line 显示文本；默认 buildDefaultStatusLine，配 custom command 时由 polling 覆盖
  const [statusLineText, setStatusLineText] = useState<string>(() =>
    buildDefaultStatusLine({
      providerLabel: initialRuntimeState.providerLabel,
      modelLabel: initialRuntimeState.modelLabel,
      permissionMode: initialRuntimeState.permissionMode,
      workspace: bootInfo.workspace,
    })
  );

  useEffect(() => {
    return queryEngine.subscribe(() => {
      setRuntimeState(queryEngine.getRuntimeState());
      setMessages(queryEngine.getVisibleMessages());
      setPendingApproval(queryEngine.getPendingApproval());
    });
  }, [queryEngine]);

  // 没配 custom command 时，让默认 status line 跟随 runtime state 变化
  useEffect(() => {
    if (statusLine?.command) return; // custom polling 接管
    setStatusLineText(
      buildDefaultStatusLine({
        providerLabel: runtimeState.providerLabel,
        modelLabel: runtimeState.modelLabel,
        permissionMode: runtimeState.permissionMode,
        workspace: bootInfo.workspace,
      })
    );
  }, [statusLine?.command, runtimeState.providerLabel, runtimeState.modelLabel, runtimeState.permissionMode, bootInfo.workspace]);

  // 配置了 custom command → 启 polling，cleanup on unmount
  useEffect(() => {
    if (!statusLine?.command) return;
    const handle = startCustomStatusLine({
      command: statusLine.command,
      intervalMs: statusLine.intervalMs,
      fallbackText: "[status line failed]",
      onUpdate: (t) => setStatusLineText(t),
    });
    return () => handle.stop();
  }, [statusLine?.command, statusLine?.intervalMs]);

  useInput((value, key) => {
    if (key.escape) {
      setBanner(null);
    }

    if (key.ctrl && value === "c") {
      if (isRunning) {
        ingressGateway.handleInterrupt(queryEngine.getSessionId());
        setBanner("Interrupt requested · 已请求中断；等待当前轮次停止。");
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
    // P4.1：ref 同步守卫 + state 异步守卫双保险
    if (!trimmed || isRunningRef.current || isRunning) {
      return;
    }

    if (trimmed === "/exit") {
      exit();
      return;
    }

    isRunningRef.current = true;
    setInput("");
    setIsRunning(true);

    const stream = ingressGateway.handleMessage(
      createCliIngressMessage(trimmed, {
        userId: "local-user",
        sessionId: queryEngine.getSessionId(),
        workspace: bootInfo.workspace
      })
    );
    setMessages(queryEngine.getVisibleMessages());
    let turnErrorMessage: string | null = null;

    try {
      for await (const envelope of stream) {
        const event = envelope.payload;
        if (event.type === "phase") {
          setPhase(event.phase);
          if (event.phase === "halted") {
            setBanner("Turn halted by interrupt · 当前轮次已被中断。");
          }
          // v0.8.5：进入 planning/executing 阶段先打"思考中"占位（后续 tool-start / message-start 会接管）
          if (!STREAM_OUTPUT_ENABLED && (event.phase === "planning" || event.phase === "executing")) {
            setToolStatus("🤔 思考中... · thinking");
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
              ? `${event.totalPending} approvals queued · 待审批队列 ${event.totalPending} 项；当前 ${event.toolName}。/approve 或 /deny。`
              : `Approval required for ${event.toolName} · 需要审批：${event.toolName}。/approve 或 /deny。`
          );
          continue;
        }

        if (event.type === "approval-cleared") {
          const nextPendingApproval = queryEngine.getPendingApproval();
          setPendingApproval(nextPendingApproval);
          setBanner(
            nextPendingApproval
              ? `${nextPendingApproval.totalPending} approvals still queued · 仍有 ${nextPendingApproval.totalPending} 项待审批。`
              : null
          );
          continue;
        }

        if (event.type === "tool-start") {
          // v0.8.5：沉默模式下加 emoji 区分阶段
          setToolStatus(STREAM_OUTPUT_ENABLED ? `${event.toolName} running` : `🔧 调用 ${event.toolName}...`);
          continue;
        }

        if (event.type === "tool-end") {
          // v0.8.5：tool 结束后回到"思考中"占位（等下个 tool-start / message-complete）
          if (!STREAM_OUTPUT_ENABLED) {
            setToolStatus(`✓ ${event.toolName} ${event.status} · 🤔 思考中...`);
          } else {
            setToolStatus(`${event.toolName} ${event.status}`);
          }
          continue;
        }

        if (event.type === "message-start") {
          // v0.8.5：沉默模式不预先 push 空 message（避免空气泡污染历史）；message-complete 时一次性 push
          if (!STREAM_OUTPUT_ENABLED) {
            setToolStatus("✍️ 生成回答... · streaming");
            continue;
          }
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
          // v0.8.5 默认沉默：流式 token 不渲染到屏幕，仅靠 toolStatus 显示状态。
          // 这是治根 — pty buffer 累积的根本原因是高频流式写入；message-complete 一次性 setState
          // 把整 turn 的 ANSI 输出从 N 千次降到 1 次。
          if (!STREAM_OUTPUT_ENABLED) {
            continue;
          }
          // v0.8.4 老行为（CODECLAW_STREAM_OUTPUT=1 退路）：newline-gated commit
          const id = event.messageId;
          const partial = (partialBuf.current.get(id) ?? "") + event.delta;
          const lastNewline = partial.lastIndexOf("\n");

          if (lastNewline === -1) {
            partialBuf.current.set(id, partial);
          } else {
            const toCommit = partial.slice(0, lastNewline + 1);
            const newPartial = partial.slice(lastNewline + 1);
            partialBuf.current.set(id, newPartial);
            pendingCommitBuf.current.set(
              id,
              (pendingCommitBuf.current.get(id) ?? "") + toCommit
            );
            frameScheduler.schedule(`commit-${id}`, () => {
              const committed = pendingCommitBuf.current.get(id);
              if (!committed) return;
              pendingCommitBuf.current.delete(id);
              setMessages((current) =>
                current.map((message) =>
                  message.id === id ? { ...message, text: message.text + committed } : message
                )
              );
            });
          }
          continue;
        }

        if (event.type === "message-complete") {
          // v0.8.5：剥 <think> 块（除非 --show-thinking / CODECLAW_SHOW_THINKING=1）；
          // 沉默模式下这是 turn 内首次 setState 显示 message 内容
          const finalText = showThinking ? event.text : stripThinking(event.text);
          partialBuf.current.delete(event.messageId);
          pendingCommitBuf.current.delete(event.messageId);
          if (!STREAM_OUTPUT_ENABLED) {
            // 沉默模式：message-start 没 push，这里 push + 设 text
            setMessages((current) => {
              const exists = current.some((m) => m.id === event.messageId);
              if (exists) {
                return current.map((m) =>
                  m.id === event.messageId ? { ...m, text: finalText } : m
                );
              }
              return [...current, { id: event.messageId, role: "assistant", text: finalText }];
            });
            setToolStatus(null);
          } else {
            setMessages((current) =>
              current.map((message) =>
                message.id === event.messageId ? { ...message, text: finalText } : message
              )
            );
          }
          continue;
        }
        // subagent-start / subagent-end：ink CLI 暂不展示，留给 web channel
      }
    } catch (error) {
      turnErrorMessage = formatTurnError(error);
      setBanner(`Turn failed: ${turnErrorMessage}`);
      setPhase("halted");
      setToolStatus("failed");
    } finally {
      // v0.8.4：清流式 buffer 防止下一轮 / interrupt / error 路径泄漏到下次 turn
      partialBuf.current.clear();
      pendingCommitBuf.current.clear();
      const nextPendingApproval = queryEngine.getPendingApproval();
      setPendingApproval(nextPendingApproval);
      setToolStatus(
        nextPendingApproval
          ? `${nextPendingApproval.toolName} pending approval (${nextPendingApproval.totalPending})`
          : toolStatus
      );
      setRuntimeState(queryEngine.getRuntimeState());
      const nextMessages = queryEngine.getVisibleMessages();
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
      isRunningRef.current = false;
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
      <Box borderStyle="round" paddingX={1} marginTop={1} flexDirection="column">
        <Box>
          <Text color="cyan">{"> "}</Text>
          <SafeTextInput
            value={input}
            onChange={setInput}
            onSubmit={(value) => {
              void handleSubmit(value);
            }}
          />
        </Box>
        <Text color="gray" dimColor>
          buffer · 缓冲: {input.length} chars · Backspace/←→ · Ctrl+A=home Ctrl+E=end Ctrl+U=clear Ctrl+W=del-word · Enter=send · 回车发送
        </Text>
      </Box>
      <StatusLine text={statusLineText} />
      <FooterHints />
    </Box>
  );
}
