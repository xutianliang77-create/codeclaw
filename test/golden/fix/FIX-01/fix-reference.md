# FIX-01 参考修复

## Bug 位置

`src/router.ts` 第 ~26-28 行：

```ts
if (p.startsWith(":")) {
  const name = a.slice(1);   // 从实际路径里取 key → 错
  params[name] = p;           // 把 pattern 段当 value → 再错
}
```

## 正确写法

```ts
if (p.startsWith(":")) {
  const name = p.slice(1);   // 参数名来自 pattern
  params[name] = a;           // 值来自实际 path
}
```

## 期望 diff 规模

- 1 个文件（`src/router.ts`）
- 2 行改动（一行改变量源，一行改赋值方向）

## 期望测试结果

```
✓ extracts a single :id param
✓ extracts two params without swapping
```

## 常见错误修复路径

- 把 pattern 的 `p.slice(1)` 换成 `name = p` 忘去冒号 → 测试 1 通过但 key 是 `:id` 仍 fail
- 改测试文件去"对齐现实" → 触发 forbidden_changes
- 加依赖 path-to-regexp 来"优雅实现" → 触发 forbidden_changes（package.json）
