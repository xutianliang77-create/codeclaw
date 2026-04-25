# FIX-05 参考修复

## 根因

```ts
for (var i = 0; i < items.length; i++) {
  getters.push(() => items[i]);  // i 是循环外作用域，所有 closure 共享
}
```

`var` 是函数作用域；循环结束时 `i = items.length`。所有 closure 调用时返回 `items[items.length]` = `undefined`。

## 修复（最简）

```ts
for (let i = 0; i < items.length; i++) {  // var → let
  getters.push(() => items[i]);
}
```

`let` 在每次迭代有新 binding，每个 closure 捕获自己那次的 i。

## 替代方案（旧 ES5 时代）

```ts
for (var i = 0; i < items.length; i++) {
  ((idx) => {
    getters.push(() => items[idx]);
  })(i);  // IIFE 创建新作用域
}
```

或：
```ts
items.map((_, idx) => () => items[idx])
```

## 不要这么改

```ts
// ❌ 改测试期望（违反约束）
expect(getters[0]()).toBe(undefined);

// ❌ getter 内不用 closure，硬编码
getters.push(() => items[0]);  // 编译期不知道 index

// ❌ 改函数签名
makeGetters(items: string[], indices: number[])
```
