# FIX-07 参考修复

## 根因

```ts
const user = await fetchUser(userId);            // 等 80ms
const orders = await fetchOrders(userId);        // 再等 80ms
const notifications = await fetchNotifications(userId);  // 再等 80ms
// 总：240ms（串行）
```

每个 `await` 都阻塞下一行；三段变成"等完一个再启下一个"。三段无依赖，应该并发启动。

## 修复

```ts
export async function loadDashboard(userId: string): Promise<DashboardData> {
  const [user, orders, notifications] = await Promise.all([
    fetchUser(userId),
    fetchOrders(userId),
    fetchNotifications(userId),
  ]);
  return { user, orders, notifications };
}
// 总：~80ms（最慢的那段）
```

## 关键点

| 写法 | 行为 |
|---|---|
| `await fetchA(); await fetchB();` | 串行，等完 A 才发 B |
| `Promise.all([fetchA(), fetchB()])` | 同时发起，等都完 |
| `Promise.allSettled([...])` | 同上但不因一个错误整体 reject |

注意：**调用** `fetchA()` 时 promise 已经创建并开始执行；只有 `await` 才阻塞。所以 `Promise.all` 接收的是已经在跑的 promises。

## 不要这么改

```ts
// ❌ 把 fetch 改成同步：违反"独立请求"模型
function fetchUserSync(...) { ... }

// ❌ 改测试 timeout：绕过性能问题，不解决

// ❌ 自己写 worker pool：杀鸡用牛刀，3 个 promise 用 Promise.all 就够

// ❌ 用 setTimeout 凑时间：可能本机过得了，CI 慢机器仍 fail
```

## 进阶：错误处理

如果某段失败：
- `Promise.all` 会立刻 reject 整体
- 想"任一失败也返已成功的部分" → 用 `Promise.allSettled`
- 本题测试只看正常路径 + 总耗时，不需要 allSettled
