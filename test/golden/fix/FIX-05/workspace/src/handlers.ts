/**
 * 给一组 item 生成"按 index 取值"的 closure 列表。
 *
 * 已知 bug：用 var 声明循环变量，所有 closure 共享同一个 i，
 * 调用时全部返回最后一次的值（或 undefined）。
 *
 * 请只改 src/handlers.ts，让 makeGetters(items)[k]() 返回 items[k]。
 */

export function makeGetters(items: string[]): Array<() => string | undefined> {
  const getters: Array<() => string | undefined> = [];
  for (var i = 0; i < items.length; i++) {
    getters.push(() => items[i]);
  }
  return getters;
}
