import { describe, it, expect } from "vitest";
import { reducer, type Action } from "../src/reducer";

describe("counter reducer", () => {
  it("handles increment", () => {
    expect(reducer({ count: 0 }, { type: "increment" })).toEqual({ count: 1 });
  });

  it("handles reset", () => {
    expect(reducer({ count: 9 }, { type: "reset" })).toEqual({ count: 0 });
  });

  it("returns prev state for unknown action", () => {
    const prev = { count: 5 };
    // 故意用 as unknown 绕 TS 检查，模拟运行时传入未定义 action
    const next = reducer(prev, { type: "foo" } as unknown as Action);
    expect(next).toEqual(prev);
  });
});
