# FIX-06 参考修复

## 根因

```ts
Object.assign(state.user, patch);  // 直接 mutate state.user
return { ...state };               // 顶层浅拷贝，user 还是原引用
```

`{ ...state }` 只是顶层浅复制；`state.user` 与新对象的 `.user` 指向同一个对象。`Object.assign` 修改它就污染了原 state。

## 修复（最自然）

```ts
return {
  ...state,
  user: { ...state.user, ...patch },
};
```

不调用 `Object.assign`；直接构造新 user 对象。

## 也可以

```ts
const newUser = { ...state.user, ...patch };
return { ...state, user: newUser };
```

或：
```ts
return { ...state, user: Object.assign({}, state.user, patch) };
//                              ^^^ 第一个参数是 {}，新对象
```

## 不要这么改

```ts
// ❌ 改测试
expect(s1.user.name).toBe("bob");  // 接受 mutation

// ❌ 在调用方手动复制
function updateUser(state, patch) {
  const stateCopy = { ...state, user: { ...state.user } };  // 多一步
  Object.assign(stateCopy.user, patch);
  return stateCopy;
}
// 能 work，但更复杂

// ❌ 用 lodash.cloneDeep
import { cloneDeep } from "lodash";  // 题目无 lodash 依赖
```
