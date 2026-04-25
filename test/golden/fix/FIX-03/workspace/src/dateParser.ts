/**
 * 把 "YYYY-MM-DD" 字符串解析为本地时区的 0:00 Date。
 *
 * 已知 bug：当前实现用 new Date(s)，会按 UTC 解析；
 * 在 UTC- 时区（如 America/Los_Angeles）下取 .getDate() 会拿到前一天。
 *
 * 请修这里，使函数在任何时区下都返回当地的同一天 0:00。
 */

export function parseLocalDate(s: string): Date {
  // BUG：直接交给 Date 构造器，YYYY-MM-DD 被当成 UTC
  return new Date(s);
}

/** 给定 Date，按本地时区返回 [年, 月(1-12), 日] */
export function localYMD(d: Date): [number, number, number] {
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}
