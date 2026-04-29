// 剥掉 LLM 输出里的思考过程标签（v0.8.5）。
//
// LM Studio 27B / DeepSeek R1 / Qwen3 reasoning 等模型常用 <think>...</think> 或
// <thinking>...</thinking> 标签把 reasoning 内容混在 content 里。默认 UI 应只显示最终答案；
// 用户传 --show-thinking flag 或设 CODECLAW_SHOW_THINKING=1 时保留原文。
//
// 处理规则：
//   - 大小写不敏感的 <think> / <thinking> 块，含跨行内容
//   - 配对的开闭标签整体移除
//   - 未闭合的标签：保守起见，从开标签到文本末尾视为思考（流式响应中模型可能没来得及闭合）
//   - 多个独立块都剥
//   - 移除后产生的连续多余空行折成一个

const TAG_RE = /<\s*(think|thinking)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi;
const UNCLOSED_TAG_RE = /<\s*(think|thinking)\s*>[\s\S]*$/i;

export function stripThinking(text: string): string {
  if (!text) return text;
  let out = text.replace(TAG_RE, "");
  out = out.replace(UNCLOSED_TAG_RE, "");
  // 多个连续空行折成一个，trim 首尾
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}
