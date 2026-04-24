/**
 * CodeClaw 统一错误类（详细技术设计 §8.5）
 *
 * 约定：
 *   - 业务 / 可恢复错误：`throw new CodeClawError(code, message, context?)`
 *   - 工具执行错误：返回 `ToolExecutionError`，不抛（现有 `src/tools/types.ts`）
 *   - 系统错误：原生 Error 由最外层兜底
 *   - 永远不吞错：catch 必 log + 重抛 或 结构化 error
 *
 * code 命名：`ERR_<MODULE>_<REASON>`，全大写下划线
 *
 * 本模块不引入外部依赖；logger 模块可以消费 `err.toJSON()` 做结构化日志
 */

export type CodeClawErrorCode =
  | "ERR_AUTH_TOKEN_EXPIRED"
  | "ERR_AUTH_TOKEN_PERMISSION_WEAK"
  | "ERR_AUTH_DEVICE_MISMATCH"
  | "ERR_PERMISSION_DENIED"
  | "ERR_PERMISSION_REQUIRED"
  | "ERR_PATH_TRAVERSAL"
  | "ERR_PATH_FORBIDDEN"
  | "ERR_SECRET_DETECTED"
  | "ERR_LOOP_DETECTED"
  | "ERR_COST_LIMIT"
  | "ERR_COST_EXCEEDED"
  | "ERR_TOKEN_LIMIT"
  | "ERR_PROVIDER_TIMEOUT"
  | "ERR_PROVIDER_RATE_LIMIT"
  | "ERR_PROVIDER_UNREACHABLE"
  | "ERR_PROVIDER_INVALID_RESPONSE"
  | "ERR_LLM_BUDGET_EXCEEDED"
  | "ERR_STORAGE_SCHEMA_BREAKING"
  | "ERR_STORAGE_WRITE_FAILED"
  | "ERR_AUDIT_CHAIN_BROKEN"
  | "ERR_DEDUP_DUPLICATE"
  | "ERR_SKILL_LOAD_FAILED"
  | "ERR_SKILL_NOT_AUTHORIZED"
  | "ERR_SESSION_NOT_FOUND"
  | "ERR_UNKNOWN"
  | (string & {}); // 兼容扩展，新增未在枚举的 code 仍可通过；但建议先补上面

/** 标准化上下文（所有都可选，避免 any） */
export interface CodeClawErrorContext {
  traceId?: string;
  sessionId?: string;
  tenantId?: string;       // 企业版前置
  action?: string;
  resource?: string;
  provider?: string;
  model?: string;
  cause?: unknown;
  [k: string]: unknown;
}

export class CodeClawError extends Error {
  readonly code: CodeClawErrorCode;
  readonly context: CodeClawErrorContext;

  constructor(code: CodeClawErrorCode, message: string, context: CodeClawErrorContext = {}) {
    super(message);
    this.name = "CodeClawError";
    this.code = code;
    this.context = { ...context };
    // 保留原始 Error stack；若 context.cause 是 Error，附到 cause 字段以便链式调试
    if (context.cause instanceof Error) {
      (this as Error & { cause?: unknown }).cause = context.cause;
    }
  }

  /** 序列化为日志 / 审计可消费的结构 */
  toJSON(): Record<string, unknown> {
    const cause = this.context.cause;
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: omitUndefined({
        ...this.context,
        cause: cause instanceof Error ? { name: cause.name, message: cause.message } : cause,
      }),
      stack: this.stack,
    };
  }
}

/** 类型守卫 */
export function isCodeClawError(err: unknown): err is CodeClawError {
  return err instanceof CodeClawError;
}

/** 从未知错误包装为 CodeClawError（保留原 stack；用于出站边界） */
export function wrapAsCodeClawError(
  err: unknown,
  code: CodeClawErrorCode = "ERR_UNKNOWN",
  extra: CodeClawErrorContext = {}
): CodeClawError {
  if (isCodeClawError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new CodeClawError(code, message, { ...extra, cause: err });
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
