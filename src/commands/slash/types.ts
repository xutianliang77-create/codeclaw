/**
 * Slash 命令注册表 · 核心类型（ADR-003）
 *
 * 设计目标：
 *   - 把 queryEngine.ts 里 24+ 个 if-else 硬编码命令迁到一个可插拔注册表
 *   - 每条命令自描述：name / aliases / risk / 分类 / 帮助文本 / handler
 *   - 统一参数解析约定（去 prefix 后 trim 得 argv-like string）
 *   - 返回 SlashResult 让 runtime 能区分"直接回复 / 继续执行 / 需要审批"
 *
 * 非目标：
 *   - 不处理本地工具命令（/read /bash …），那套走 src/tools/local.ts
 *   - 不处理需要 LLM 往返的命令（走正常 chat pipeline）
 *
 * 与 queryEngine 的边界：
 *   - registry 只负责"命令注册 + 路由 + 参数解析 + 帮助汇总"
 *   - 具体业务（权限、会话、审批……）通过 context 对象注入
 */

export type SlashRisk = "low" | "medium" | "high";

export type SlashCategory =
  | "session"
  | "permission"
  | "observability"
  | "memory"
  | "provider"
  | "plugin"
  | "integration"
  | "workflow"
  | "help";

/** 运行时注入给 handler 的上下文（最小集，用到什么加什么） */
export interface SlashContext {
  /** 原始 prompt（含 `/xxx` 前缀 + 空格后的参数） */
  rawPrompt: string;
  /** 命令名（已归一化成主 name，不是 alias） */
  commandName: string;
  /** 去 prefix 后的参数字符串（已 trim；未按空格切分） */
  argsRaw: string;
  /** 按空白切分后的参数数组（便于简单命令直接用） */
  argv: string[];
  /** 回调：handler 需要查会话 / 状态时可以取这些 */
  queryEngine: unknown;
}

/** handler 返回值的几种 */
export type SlashResult =
  /** 直接回复文本，runtime 会把它当成 assistant 消息打出去 */
  | { kind: "reply"; text: string }
  /** 无操作（比如命令故意静默，或者已由 handler 自己副作用完） */
  | { kind: "noop" }
  /** handler 明确放弃处理，让 runtime fall through 到下一条路径 */
  | { kind: "passthrough" }
  /**
   * 同 turn 内重写 prompt：runtime 把 newPrompt 当作 user 输入继续走非 slash 分发
   * （resolveBuiltinReply / detectLocalTool / LLM）。slash registry 不再二次 dispatch
   * 同一 prompt（防递归）。/ask v2 用此实现"自动注入下一轮问题"。
   */
  | { kind: "rewrite"; newPrompt: string };

export type SlashHandler = (
  ctx: SlashContext
) => SlashResult | Promise<SlashResult>;

export interface SlashCommand {
  /** 主命令名，含 `/` 前缀，小写 */
  name: string;
  /** 别名列表，含 `/` 前缀 */
  aliases?: string[];
  category: SlashCategory;
  risk: SlashRisk;
  /** 一行简介（英文；用于 /help 列表 + LLM 识别）。LLM-facing 不双语。 */
  summary: string;
  /** P6b（v0.7.0）：可选中文简介；/help 渲染时拼成「summary · summaryZh」并排格式。 */
  summaryZh?: string;
  /** 多行详细帮助（用于 /help <cmd>） */
  helpDetail?: string;
  /** 是否需要在 permission-mode != "plan" 才能跑（副作用命令） */
  requiresExecute?: boolean;
  handler: SlashHandler;
}

/** 注册冲突时怎么处理 */
export type RegisterConflictPolicy = "throw" | "overwrite" | "skip";
