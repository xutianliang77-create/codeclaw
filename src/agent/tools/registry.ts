/**
 * ToolRegistry · Native tool_use 注册表（M1-B）
 *
 * 职责：
 *   - 注册 / 反注册工具（dynamic：M3-01 MCP server 接入也走这里）
 *   - 给 OpenAI / Anthropic 生成统一 schema 数组
 *   - 调用方调 invoke(name, args, ctx) 执行
 *
 * 不变量：
 *   - register 不允许重名（防 builtin 被覆盖）
 *   - schema 用 JSONSchema-7 子集（OpenAI function 接 tools[].function.parameters；Anthropic 接 tools[].input_schema）
 *
 * 与 LocalTool 的关系：
 *   - LocalTool 是用户 typed `/read foo` 的检测路径；保留不动
 *   - ToolRegistry 是 LLM native tool_use 的执行路径；底层共享同一组 runner 函数
 */

import type { PermissionManager } from "../../permissions/manager";

/** OpenAI function calling 与 Anthropic tools 都接受这个 JSONSchema 子集 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolInvokeContext {
  workspace: string;
  permissionManager: PermissionManager;
  abortSignal?: AbortSignal;
}

export interface ToolInvokeResult {
  ok: boolean;
  content: string;
  isError?: boolean;
  errorCode?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  invoke(args: unknown, ctx: ToolInvokeContext): Promise<ToolInvokeResult>;
}

/** 流式 tool_use 解析后给 queryEngine 的事件 */
export interface ToolCallEvent {
  id: string;
  name: string;
  args: unknown;
  /** 原始 JSON 字符串（解析失败时 args 为 null） */
  raw: string;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool ${tool.name} already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 按 PermissionMode 过滤可暴露给 LLM 的 tools（M2-03）。
   * - plan: 只读 + memory_write + ExitPlanMode（write/append/replace/bash 全砍）
   * - 其他 mode：全量
   *
   * 默认 read-only 集 = read/glob/symbol/definition/references；可由 caller 通过
   * planModeAllowedTools 参数扩展（如 user 注册了自定义 read-only tool）。
   */
  listForMode(
    mode: string,
    planModeAllowedTools?: ReadonlySet<string>
  ): ToolDefinition[] {
    if (mode !== "plan") return this.list();
    const allowed =
      planModeAllowedTools ??
      new Set([
        "read",
        "glob",
        "symbol",
        "definition",
        "references",
        "read_artifact",
        "memory_write",
        "ExitPlanMode",
      ]);
    return this.list().filter((t) => allowed.has(t.name));
  }

  /** OpenAI tools 数组：[{type:"function", function:{name,description,parameters}}, ...] */
  openAiSchemas(): Array<{
    type: "function";
    function: { name: string; description: string; parameters: ToolInputSchema };
  }> {
    return this.list().map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  /** Anthropic tools 数组：[{name,description,input_schema}, ...] */
  anthropicSchemas(): Array<{
    name: string;
    description: string;
    input_schema: ToolInputSchema;
  }> {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  async invoke(
    name: string,
    args: unknown,
    ctx: ToolInvokeContext
  ): Promise<ToolInvokeResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        content: `[tool error] unknown tool: ${name}`,
        isError: true,
        errorCode: "unknown_tool",
      };
    }
    try {
      return await tool.invoke(args, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        content: `[tool error] ${msg}`,
        isError: true,
        errorCode: "invoke_failed",
      };
    }
  }
}

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}
