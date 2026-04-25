/**
 * 一个简化的 immutable store helper：每次更新返回新 state（不修改入参）。
 *
 * 已知 bug：updateUser 用 spread 只复制了顶层 state，user 对象仍是同一个引用，
 * 直接 mutate 它会污染原 state，违反 immutability。
 *
 * 请修这里。
 */

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface State {
  user: User;
  count: number;
}

export function updateUser(state: State, patch: Partial<User>): State {
  // BUG：state.user 是同一个引用；mutate 它会污染原 state
  Object.assign(state.user, patch);
  return { ...state };
}
