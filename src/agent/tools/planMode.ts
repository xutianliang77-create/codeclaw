/**
 * Plan mode 双阶段 · ExitPlanMode tool（M2-03）
 *
 * 设计（spec §6 + patch N3 处理）：
 *   - LLM 在 plan mode 只能调 read-only tools + memory_write + ExitPlanMode
 *     （由 ToolRegistry.listForMode 过滤；plan 时 bash/write/append/replace 不可见）
 *   - LLM 完成调研后调 ExitPlanMode tool 提交 plan markdown
 *   - tool invoke 返回特殊 sentinel content：`<<EXIT_PLAN_APPROVED>>{plan json}`
 *   - queryEngine 检测此 sentinel：
 *     · 调 permissions.setMode("default")（避免反向修改 engine 状态的反模式 N3）
 *     · yield approval-request event 把 plan markdown 给 UI 显示
 *     · 当前简化：自动转 default 模式不阻塞；用户审批 + reject 留 M3 完整版
 *
 * 当前 M2-03 范围（1 d）：
 *   ✅ tool 注册 + plan mode tool 过滤
 *   ✅ ExitPlanMode 调用后自动切回 default
 *   ⏸️ 用户主动审批阻塞 / reject 重规划留 M2-04+ / M3-04 hooks 阶段
 *     （需要 multi-turn 中断 + 状态持久化 + /approve 恢复）
 */

import type { ToolDefinition, ToolRegistry } from "./registry";

/** 特殊 sentinel：queryEngine 检测此前缀知道是 ExitPlanMode 调用，触发模式切换 */
export const EXIT_PLAN_SENTINEL = "<<EXIT_PLAN_APPROVED>>";

interface ExitPlanArgs {
  plan: string;
}

function exitPlanModeDef(): ToolDefinition {
  return {
    name: "ExitPlanMode",
    description:
      "Submit your read-only investigation plan as concise markdown. " +
      "After this, plan-mode restrictions lift and you continue with full tools to execute the plan. " +
      "Only call this AFTER you've finished read-only research and have a clear actionable plan.",
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description: "Markdown plan: bullet list of steps, key files to modify, expected outcomes",
        },
      },
      required: ["plan"],
    },
    async invoke(args, _ctx) {
      const a = (args ?? {}) as Partial<ExitPlanArgs>;
      if (typeof a.plan !== "string" || !a.plan.trim()) {
        return {
          ok: false,
          content: "[ExitPlanMode] plan must be a non-empty string",
          isError: true,
          errorCode: "invalid_args",
        };
      }
      const planMd = a.plan.trim();
      // sentinel 让 queryEngine multi-turn 检测后调 setMode("default")，避免 tool 反向改 engine
      return {
        ok: true,
        content: `${EXIT_PLAN_SENTINEL}\n${planMd}`,
      };
    },
  };
}

export function registerPlanModeTool(registry: ToolRegistry): void {
  registry.register(exitPlanModeDef());
}
