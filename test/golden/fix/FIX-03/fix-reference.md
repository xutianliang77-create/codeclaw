# FIX-03 参考修复

## 根因

`new Date("2024-12-31")` 按 ISO 8601 规则被解析为 **UTC 0:00**：
```
Tue Dec 31 2024 00:00:00 UTC
= Mon Dec 30 2024 16:00:00 PST (UTC-8)
```
然后 `.getDate()` 在 PST 下返回 30，所以 `localYMD` 返回 `[2024, 12, 30]`，不是预期的 `[2024, 12, 31]`。

只有当使用本地时区构造（`new Date(year, monthIndex, day)`）时，结果才与时区无关。

## 修复

```ts
export function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
```

要点：
- 拆字符串为 [年, 月, 日]
- 用 `new Date(y, monthIndex, d)` 构造 → 按本地时区 0:00
- monthIndex 从 0 开始，所以 `m - 1`

## 不要这么改

```ts
// ❌ 用 setHours / 时区偏移修正：复杂且 DST 边界不稳
const d = new Date(s);
d.setMinutes(d.getMinutes() + d.getTimezoneOffset());

// ❌ 用 UTC 方法忽略本地时区：测试要求"本地"日期
return new Date(s).toLocaleDateString();  // 还是 Date 对象，但内部仍 UTC

// ❌ 改测试 / 改 tsconfig
```

## 修一行就够吗

最少一行：
```ts
return new Date(...s.split("-").map(Number) as [number, number, number]).setMonth(...);
```
但不可读。建议 3 行最自然。
