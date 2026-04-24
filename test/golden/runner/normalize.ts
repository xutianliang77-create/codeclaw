/**
 * Golden Set Scorer —— 字符串归一化
 *
 * 对齐 doc/specs/golden-set.md §3.4：
 *   - Unicode NFKC（把全角数字/字母、兼容汉字、压缩空格等规范化）
 *   - 大小写归一（toLowerCase）
 *   - 空白压缩（多空白 → 单个空格；首尾 trim）
 *   - 简繁：P1 再接 opencc-js；P0 仅做 NFKC + 大小写 + 空白（足够主力模型稳定匹配）
 *
 * 不做：标点去除（保留原始标点，保留语义）
 */

/** 归一化字符串：用于 must_mention / must_not_mention 的匹配 */
export function normalize(input: string): string {
  if (input == null) return "";
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** 在 `haystack` 中查找 `needle` 的子串命中（归一化后） */
export function matchesSubstring(haystack: string, needle: string): boolean {
  const h = normalize(haystack);
  const n = normalize(needle);
  if (n.length === 0) return true;
  return h.includes(n);
}

/** 判断多个 needle 是否至少一个命中（用于 must_mention 中单条 "A 或 B 或 C" 写法） */
export function matchesAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => matchesSubstring(haystack, n));
}
