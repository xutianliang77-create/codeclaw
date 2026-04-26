/**
 * RAG tokenizer · BM25 用（M4-#75 step b）
 *
 * 切词策略：
 *   - 按 [a-zA-Z0-9_] 切片；其他字符视为分隔符
 *   - 转小写；过滤长度 < 2 的 token（噪音）
 *   - 单文件 / query 用同一函数；BM25 才能匹配
 *
 * 不做 stop word 过滤：代码场景里 "for" "if" "in" 等同样有信息量，
 * 别"优化"过头反而拖低召回。
 */

const TOKEN_RE = /[a-zA-Z0-9_]+/g;
const MIN_TOKEN_LEN = 2;

export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    if (m[0].length >= MIN_TOKEN_LEN) out.push(m[0]);
  }
  return out;
}

export function tokenFreqs(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tokenize(text)) {
    map.set(t, (map.get(t) ?? 0) + 1);
  }
  return map;
}
