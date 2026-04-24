/**
 * 极简 counter reducer（模拟 React useReducer 场景）
 *
 * 已知 bug：对 unknown action type 没有 default 分支。
 * 影响：传入未定义的 action 会让 reducer 返回 undefined，
 *      下一轮 React 再用这个 state 就 UI 炸。请修复。
 */

export interface State {
  count: number;
}

export type Action =
  | { type: "increment" }
  | { type: "decrement" }
  | { type: "reset" };

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "increment":
      return { count: state.count + 1 };
    case "decrement":
      return { count: state.count - 1 };
    case "reset":
      return { count: 0 };
    // BUG: 没有 default 分支。任何非上面列出的 action 都会导致函数执行完不 return。
  }
}
