/**
 * Golden Set —— LLM 调用抽象
 *
 * W0 阶段用 mock 实现（从 fixture 读预期答案），保证 runner 骨架可跑。
 * P0 W2 对接真实 provider 前会替换为 src/provider/chain 的 invoke；接口保持一致。
 */

import type { AskQuestion } from "./types";

export interface LlmInvocation {
  provider?: string;
  modelId?: string;
  answer: string;
  latencyMs: number;
  /** W4-real：真实 provider 返回的 token 用量（mock invoker 没这俩字段） */
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmInvoker {
  invoke(question: AskQuestion): Promise<LlmInvocation>;
}

/**
 * Mock：按题目的 must_mention 拼凑答案；保证 scorer 能打到满分
 * 用于：
 *   - dry-run 验证 runner
 *   - CI pre-push 快速回归（避免耗 LLM token）
 *   - W0 阶段调试 runner 骨架
 */
export class MockLlmInvoker implements LlmInvoker {
  async invoke(question: AskQuestion): Promise<LlmInvocation> {
    const start = Date.now();
    const parts: string[] = [];
    parts.push(`[mock answer for ${question.id}]`);
    for (const m of question.expected.must_mention ?? []) {
      parts.push(m);
    }
    // 不提 must_not_mention 里的关键词
    const answer = parts.join("\n");
    // 模拟一点延迟让 latencyMs 非 0
    await new Promise((r) => setTimeout(r, 5));
    return {
      provider: "mock",
      modelId: "mock-deterministic",
      answer,
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Mock · 故意失败：返回空字符串，测 pass 判定的反向路径
 */
export class FailingMockLlmInvoker implements LlmInvoker {
  async invoke(_question: AskQuestion): Promise<LlmInvocation> {
    await new Promise((r) => setTimeout(r, 1));
    return { provider: "mock", modelId: "mock-failing", answer: "", latencyMs: 1 };
  }
}

/**
 * 真实 provider 接入。两条路径：
 *
 * 1. 默认（裸壳测试）：直接 streamProviderResponse + 单条 user message —— pre-M1 baseline 用
 * 2. env GOLDEN_M1_SYSTEM_PROMPT=true：在 messages[0] 注入 buildSystemPrompt() 模拟 M1-A 用户体感
 *    —— 但仍单轮（M1-B.2 multi-turn 不会触发）
 * 3. env GOLDEN_M1_QUERY_ENGINE=true：走 QueryEngine.submitMessage 完整路径
 *    —— 含 M1-A system prompt + M1-B native tool_use + M1-B.2 multi-turn dispatch
 *    最 fair 的 M1 baseline 测量方式
 *
 * 三条路径 mutually exclusive；优先级 3 > 2 > 1
 */
export async function createRealInvoker(): Promise<LlmInvoker> {
  const { loadRuntimeSelection } = await import("../../../src/provider/registry");
  const { config, selection } = await loadRuntimeSelection();
  if (!config || !selection || !selection.current) {
    throw new Error(
      "No usable provider configured. Run `codeclaw setup` or `codeclaw config` first."
    );
  }
  const provider = selection.current;

  if (process.env.GOLDEN_M1_QUERY_ENGINE === "true") {
    return createQueryEngineInvoker(provider);
  }

  return createStreamInvoker(provider, process.env.GOLDEN_M1_SYSTEM_PROMPT === "true");
}

/**
 * 路径 1/2：streamProviderResponse 单轮。systemPrompt 可选注入。
 */
async function createStreamInvoker(
  provider: import("../../../src/provider/types").ProviderStatus,
  injectSystemPrompt: boolean
): Promise<LlmInvoker> {
  const { streamProviderResponse } = await import("../../../src/provider/client");

  let systemPromptText: string | null = null;
  if (injectSystemPrompt) {
    const { buildSystemPrompt } = await import("../../../src/agent/systemPrompt");
    const { SlashRegistry, loadBuiltins } = await import("../../../src/commands/slash");
    const { createSkillRegistryFromDisk } = await import("../../../src/skills/registry");
    const { createToolRegistry } = await import("../../../src/agent/tools/registry");
    const { registerBuiltinTools } = await import("../../../src/agent/tools/builtins");

    const slashRegistry = new SlashRegistry();
    loadBuiltins(slashRegistry);
    const skillRegistry = createSkillRegistryFromDisk();
    const toolRegistry = createToolRegistry();
    if (process.env.CODECLAW_NATIVE_TOOLS === "true") {
      registerBuiltinTools(toolRegistry);
    }

    systemPromptText = buildSystemPrompt({
      workspace: process.cwd(),
      permissionMode: "default",
      provider,
      slashRegistry,
      skillRegistry,
      toolRegistry,
    });
  }

  return {
    async invoke(question: AskQuestion): Promise<LlmInvocation> {
      const start = Date.now();
      let answer = "";
      let usageInputTokens = 0;
      let usageOutputTokens = 0;
      let modelId: string | undefined = provider.model;

      const messages = [
        ...(systemPromptText
          ? [{ id: "sys-1", role: "system" as const, text: systemPromptText, source: "local" as const }]
          : []),
        {
          id: "user-1",
          role: "user" as const,
          text: question.prompt,
          source: "user" as const,
        },
      ];

      try {
        for await (const chunk of streamProviderResponse(provider, messages, {
          onUsage: (u) => {
            usageInputTokens = u.inputTokens ?? 0;
            usageOutputTokens = u.outputTokens ?? 0;
            modelId = u.modelId ?? modelId;
          },
        })) {
          answer += chunk;
        }
      } catch (err) {
        answer = `[provider error] ${err instanceof Error ? err.message : String(err)}`;
      }

      return {
        provider: provider.type,
        modelId,
        answer,
        latencyMs: Date.now() - start,
        ...(usageInputTokens || usageOutputTokens
          ? { inputTokens: usageInputTokens, outputTokens: usageOutputTokens }
          : {}),
      } as LlmInvocation;
    },
  };
}

/**
 * 路径 3：QueryEngine.submitMessage 完整 multi-turn。
 * - workspace = process.cwd()（真项目根；ASK 题大多问 codeclaw 内部，需 LLM 真能 read）
 * - permissionMode: "plan"（语义只读；当前 toolRegistry.invoke 不走 evaluate（M2-04 修），
 *   所以额外保护：toolRegistry 仅注册 5 个只读 builtin（read/glob/symbol/definition/references），
 *   彻底剥离 bash/write/append/replace—— LLM 无法调用，物理上不会动项目）
 * - 每题独立 sessionId；audit/dataDb 关；session 落 tmp（不污染本机）
 * - 收 message-complete：最终 answer = 最后一个 assistant turn 的 text
 */
async function createQueryEngineInvoker(
  provider: import("../../../src/provider/types").ProviderStatus
): Promise<LlmInvoker> {
  const { createQueryEngine } = await import("../../../src/agent/queryEngine");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");

  // 物理只读保护：在 createQueryEngine 之前 monkey-patch ToolRegistry 默认注册的 builtins
  // —— 临时改 env 让 registerBuiltinTools 仍跑，但跑完后立即 unregister 4 个写工具
  // 备选做法：直接改 builtins.ts 接 env READ_ONLY；这里走 monkey-patch 保 builtins.ts 干净
  const READ_ONLY_TOOLS = new Set(["read", "glob", "symbol", "definition", "references"]);

  return {
    async invoke(question: AskQuestion): Promise<LlmInvocation> {
      const start = Date.now();
      const sessionsTmp = mkdtempSync(path.join(tmpdir(), "golden-ask-sess-"));

      let lastTurnAnswer = "";
      let buffering = "";
      let modelId: string | undefined = provider.model;

      try {
        const engine = createQueryEngine({
          currentProvider: provider,
          fallbackProvider: null,
          permissionMode: "plan",
          workspace: process.cwd(),
          channel: "cli",
          userId: "golden-ask",
          auditDbPath: null,
          dataDbPath: null,
          sessionsDir: sessionsTmp,
        });

        // 物理剥离写工具：runner 模式下不允许 LLM 真改文件
        const reg = (engine as unknown as { toolRegistry?: { list(): Array<{ name: string }>; unregister(name: string): boolean } }).toolRegistry;
        if (reg) {
          for (const t of reg.list()) {
            if (!READ_ONLY_TOOLS.has(t.name)) reg.unregister(t.name);
          }
        }

        for await (const ev of engine.submitMessage(question.prompt)) {
          if (ev.type === "message-start") {
            buffering = "";
          } else if (ev.type === "message-delta") {
            buffering += ev.delta;
          } else if (ev.type === "message-complete") {
            lastTurnAnswer = ev.text || buffering;
            buffering = "";
          }
        }
      } catch (err) {
        lastTurnAnswer = `[engine error] ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        try {
          rmSync(sessionsTmp, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }

      return {
        provider: provider.type,
        modelId,
        answer: lastTurnAnswer,
        latencyMs: Date.now() - start,
      } as LlmInvocation;
    },
  };
}
