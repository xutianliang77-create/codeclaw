/**
 * pino logger（详细技术设计 §8.3）
 *
 * 核心：
 *   - 结构化 JSON 日志（生产）
 *   - redact：敏感字段路径自动遮蔽（token / apiKey / password / authorization / bot_token / access_token）
 *   - child logger：按 module / traceId / sessionId 归档
 *
 * 暂不做（推迟）：
 *   - 落盘到 ~/.codeclaw/logs/codeclaw.jsonl —— 默认走 stdout；
 *     真正的 file transport + 按日轮转 待 W1-13 doctor 接入时统一配
 *   - pino-pretty dev 输出 —— 需要额外装包；优先减少依赖
 *
 * 调用约定：
 *   - 从模块顶层取 child：`const log = logger.child({ module: 'queryEngine' })`
 *   - 每次事件带 `{ traceId, sessionId }` 作关联键
 */

import pino from "pino";

const DEFAULT_LEVEL = process.env.CODECLAW_LOG_LEVEL ?? "info";

/**
 * redact 路径：pino 支持通配符 `*.field` 做遮蔽；
 * 只需写入常见敏感字段路径即可，不做字段内容扫描。
 * 敏感值扫描（正则形式）由 W1-12 之后的 SecretScanner 负责（P0 安全回归 T8 / T10）。
 */
const REDACT_PATHS = [
  "*.token",
  "*.apiKey",
  "*.api_key",
  "*.accessToken",
  "*.access_token",
  "*.bot_token",
  "*.password",
  "*.authorization",
  "*.headers.authorization",
  "*.headers.Authorization",
  "*.headers['x-api-key']",
];

/** 根 logger；业务代码应通过 child(...) 用 */
export const logger = pino({
  level: DEFAULT_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    bindings(bindings) {
      // 缩减默认 bindings（去掉 hostname；保留 pid 以便多进程审计）
      return { pid: bindings.pid };
    },
  },
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
    remove: false,
  },
});

/** 模块级便捷工厂 */
export function createLogger(moduleName: string, bindings: Record<string, unknown> = {}) {
  return logger.child({ module: moduleName, ...bindings });
}

/** 供测试用的"静音"logger（level=silent）；在 vitest 里默认注入避免噪声 */
export function createSilentLogger() {
  return pino({ level: "silent", redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } });
}

export type Logger = typeof logger;
