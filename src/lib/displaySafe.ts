/**
 * displaySafe · 把 LLM/外部输入的字符串净化后再展示给人类。
 *
 * 攻击场景（W4-B-SEC-4）：
 *   - LLM 在 tool call 参数里塞 \n 注入伪造的 APPROVAL 行（plain.ts 行格式攻击）
 *   - LLM 塞 ANSI escape `\x1b[2J` / `\x1b[H` 清屏让真实命令滚出视野
 *   - LLM 塞超长 payload 把真实信息推出屏幕，诱导盲批准
 *
 * 防御：审批/审计 UI 文案统一过 `sanitizeForDisplay`，原始字段（detail/prompt）
 * 在 audit log 里保留，便于事后取证；显示层永远只见净化版本。
 */

/* eslint-disable no-control-regex */
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
// 控制字符（除 tab）。换行和回车单独处理以保留可见提示。
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
/* eslint-enable no-control-regex */
const NEWLINE_RE = /[\n\r]/g;
const TAB_RE = /\t/g;

export const DEFAULT_DISPLAY_MAX_LEN = 200;

/**
 * 用于 UI 展示的字符串净化：
 *   - 剥离 ANSI escape 序列
 *   - 控制字符替换为 `·`
 *   - 换行替换为 ` ↵ ` 让 plain.ts 等"一行一记录"格式不被注入
 *   - tab 替换为 4 空格
 *   - 超长截断并加省略号
 *
 * @param maxLen 截断长度上限（含省略号位）；不限传 Infinity
 */
export function sanitizeForDisplay(s: string, maxLen = DEFAULT_DISPLAY_MAX_LEN): string {
  if (!s) return "";
  let out = s
    .replace(ANSI_ESCAPE_RE, "")
    .replace(NEWLINE_RE, " ↵ ")
    .replace(TAB_RE, "    ")
    .replace(CONTROL_CHARS_RE, "·");
  if (out.length > maxLen) {
    out = out.slice(0, maxLen - 1) + "…";
  }
  return out;
}
