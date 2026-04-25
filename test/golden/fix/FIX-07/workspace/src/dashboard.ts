/**
 * 一个 dashboard 数据加载器：要拉 user / orders / notifications 三段独立数据。
 *
 * 已知性能 bug：现实现是串行 await，三段加在一起 ≈ 三段时间之和；
 * 本来三段无依赖，应该并发拉取，总时间 ≈ 最慢一段。
 *
 * 请改 src/dashboard.ts，让 loadDashboard 总耗时 ≈ max(三段耗时)。
 */

export interface DashboardData {
  user: { id: string; name: string };
  orders: number[];
  notifications: string[];
}

// 三个 fetch 函数；模拟独立网络请求
export async function fetchUser(id: string): Promise<{ id: string; name: string }> {
  await delay(80);
  return { id, name: `user-${id}` };
}

export async function fetchOrders(_id: string): Promise<number[]> {
  await delay(80);
  return [101, 102, 103];
}

export async function fetchNotifications(_id: string): Promise<string[]> {
  await delay(80);
  return ["msg-a", "msg-b"];
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// BUG：三段 await 串行
export async function loadDashboard(userId: string): Promise<DashboardData> {
  const user = await fetchUser(userId);
  const orders = await fetchOrders(userId);
  const notifications = await fetchNotifications(userId);
  return { user, orders, notifications };
}
