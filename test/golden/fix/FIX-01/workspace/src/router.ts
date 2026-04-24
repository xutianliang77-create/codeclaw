/**
 * 极简路径参数解析器
 *
 * 给定 pattern: /users/:id/books/:bookId
 * 给定 path:    /users/42/books/7
 * 期望:         { id: "42", bookId: "7" }
 *
 * 已知 bug：params 的 key / value 有错位。请修复。
 */

export interface MatchResult {
  matched: boolean;
  params: Record<string, string>;
}

export function match(pattern: string, path: string): MatchResult {
  const pSegs = pattern.split("/").filter(Boolean);
  const aSegs = path.split("/").filter(Boolean);
  if (pSegs.length !== aSegs.length) return { matched: false, params: {} };

  const params: Record<string, string> = {};

  for (let i = 0; i < pSegs.length; i++) {
    const p = pSegs[i]!;
    const a = aSegs[i]!;
    if (p.startsWith(":")) {
      // BUG：从 actual path segment 里取名字，而不是从 pattern 里
      const name = a.slice(1);
      params[name] = p;
    } else if (p !== a) {
      return { matched: false, params: {} };
    }
  }

  return { matched: true, params };
}
