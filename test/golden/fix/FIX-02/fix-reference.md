# FIX-02 参考修复

## Bug

`src/reducer.ts` 的 switch 缺 default 分支，对未声明 action 类型会让函数执行完不 return，
TypeScript 严格模式其实已经在类型上有覆盖（Action 是联合类型，所有 case 覆盖后 TS 认为函数返回 `never` 走完），
但**运行时**如果 action 对象绕过 TS（如 JSON 反序列化、as unknown 强转）进来，就会拿到 `undefined`。

## 正确修复

在 switch 后加 default：

```ts
switch (action.type) {
  case "increment":
    return { count: state.count + 1 };
  case "decrement":
    return { count: state.count - 1 };
  case "reset":
    return { count: 0 };
  default:
    return state;   // ← 关键
}
```

## 期望 diff 规模

- 1 个文件
- 2 行改动（加 `default:` 和 `return state;`）

## 常见错误修复路径

- 在 reducer 开头加 `if (!["increment","decrement","reset"].includes(action.type)) return state;`
  → 能过测试但行数和 exhaustiveness 不如 default
- 改测试文件把"unknown action" case 删掉 → 触发 forbidden_changes
- 把 Action 类型扩展加一个 `"noop"` → 测试仍会拿 `"foo"` 进来，仍 fail
