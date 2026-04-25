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
 * 真实 provider 接入（W3 后期落地）：
 * 用户配置文件 + streamProviderResponse 包装成 LlmInvoker。
 * 跑前会从 ~/.codeclaw 读 providers.json 和 config.yaml，挑出 default provider。
 */
export async function createRealInvoker(): Promise<LlmInvoker> {
  const { loadRuntimeSelection } = await import("../../../src/provider/registry");
  const { streamProviderResponse } = await import("../../../src/provider/client");

  const { config, selection } = await loadRuntimeSelection();
  if (!config || !selection || !selection.current) {
    throw new Error(
      "No usable provider configured. Run `codeclaw setup` or `codeclaw config` first."
    );
  }
  const provider = selection.current;

  return {
    async invoke(question: AskQuestion): Promise<LlmInvocation> {
      const start = Date.now();
      let answer = "";
      let usageInputTokens = 0;
      let usageOutputTokens = 0;
      let modelId: string | undefined = provider.model;

      const messages = [
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
        // 失败时把错误塞进 answer，让 scorer 走"没命中 must_mention"路径自然 fail
        answer = `[provider error] ${err instanceof Error ? err.message : String(err)}`;
      }

      return {
        provider: provider.type,
        modelId,
        answer,
        latencyMs: Date.now() - start,
        // 携带真实 token 用量供 runner / report 累加
        ...(usageInputTokens || usageOutputTokens
          ? {
              inputTokens: usageInputTokens,
              outputTokens: usageOutputTokens,
            }
          : {}),
      } as LlmInvocation;
    },
  };
}
