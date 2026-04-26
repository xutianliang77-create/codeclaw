import { beforeEach, describe, expect, it } from "vitest";
import { useSubagentsStore, type SubagentRow } from "./subagents";

const ROW: SubagentRow = {
  id: "sa-1",
  role: "Explore",
  prompt: "find auth",
  status: "running",
  startedAt: 1_700_000_000_000,
};

describe("useSubagentsStore", () => {
  beforeEach(() => {
    useSubagentsStore.setState({ bySession: new Map() });
  });

  it("start unshifts 到顶部", () => {
    const s = useSubagentsStore.getState();
    s.start("sess-A", { ...ROW, id: "sa-1" });
    s.start("sess-A", { ...ROW, id: "sa-2", role: "Plan" });
    expect(s.get("sess-A").map((r) => r.id)).toEqual(["sa-2", "sa-1"]);
  });

  it("start 同 id 触发 update（避免 SSE+polling 重复）", () => {
    const s = useSubagentsStore.getState();
    s.start("sess-A", { ...ROW });
    s.start("sess-A", { ...ROW, role: "RoleChanged" });
    const arr = s.get("sess-A");
    expect(arr.length).toBe(1);
    expect(arr[0].role).toBe("RoleChanged");
  });

  it("end 更新 status / durationMs / error", () => {
    const s = useSubagentsStore.getState();
    s.start("sess-A", { ...ROW });
    s.end("sess-A", "sa-1", {
      status: "completed",
      durationMs: 1234,
      toolCallCount: 5,
      finishedAt: 1_700_000_001_234,
    });
    const r = s.get("sess-A")[0];
    expect(r.status).toBe("completed");
    expect(r.durationMs).toBe(1234);
    expect(r.toolCallCount).toBe(5);
  });

  it("end 不存在的 id → noop", () => {
    const s = useSubagentsStore.getState();
    s.start("sess-A", { ...ROW });
    expect(() => s.end("sess-A", "ghost", { status: "failed" })).not.toThrow();
    expect(s.get("sess-A")[0].status).toBe("running");
  });

  it("setAll 替换整组（polling hydrate 用）", () => {
    const s = useSubagentsStore.getState();
    s.start("sess-A", { ...ROW });
    s.setAll("sess-A", [{ ...ROW, id: "sa-9" }]);
    expect(s.get("sess-A").map((r) => r.id)).toEqual(["sa-9"]);
  });

  it("跨 session 隔离", () => {
    const s = useSubagentsStore.getState();
    s.start("A", { ...ROW });
    s.start("B", { ...ROW, id: "sa-2" });
    expect(s.get("A").length).toBe(1);
    expect(s.get("B").length).toBe(1);
  });
});
