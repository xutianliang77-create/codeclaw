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
 * 真实 provider 接入占位：P0 W2 完成 Provider chain 后接上
 */
export function createRealInvoker(): LlmInvoker {
  throw new Error(
    "Real LLM invoker not wired yet. Use --mock for now; will be connected in P0 W2 after provider chain is merged."
  );
}
