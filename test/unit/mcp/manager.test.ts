/**
 * McpManager 单测（M3-01 step b）
 *
 * 用 fixtures/mcp-fake-server.cjs 做真子进程；用 args 标识 server 实例区分。
 */

import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";

import { McpManager } from "../../../src/mcp/manager";

const FAKE_SERVER = path.resolve(__dirname, "../../fixtures/mcp-fake-server.cjs");

const managers: McpManager[] = [];

function newManager(): McpManager {
  const m = new McpManager();
  managers.push(m);
  return m;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.closeAll().catch(() => undefined)));
});

describe("McpManager.start + listServers", () => {
  it("启动两个 enabled server, 跳过 disabled", async () => {
    const mgr = newManager();
    await mgr.start({
      servers: {
        a: { command: "node", args: [FAKE_SERVER] },
        b: { command: "node", args: [FAKE_SERVER] },
        c: { command: "node", args: [FAKE_SERVER], disabled: true },
      },
    });
    const snapshot = mgr.listServers();
    expect(snapshot.map((s) => s.name)).toEqual(["a", "b"]);
    expect(snapshot.every((s) => s.status === "ready")).toBe(true);
    expect(snapshot.every((s) => s.toolCount === 4)).toBe(true);
  });

  it("启动失败的 server 不阻塞其他 server", async () => {
    const mgr = newManager();
    await mgr.start({
      servers: {
        ok: { command: "node", args: [FAKE_SERVER] },
        bad: { command: "/no/such/binary-zzz" },
      },
    });
    const map = new Map(mgr.listServers().map((s) => [s.name, s]));
    expect(map.get("ok")?.status).toBe("ready");
    expect(map.get("bad")?.status).toBe("failed");
    expect(map.get("bad")?.lastError).toMatch(/.+/);
  });

  it("空 config 不抛错", async () => {
    const mgr = newManager();
    await mgr.start({ servers: {} });
    expect(mgr.listServers()).toEqual([]);
  });
});

describe("McpManager.listAllTools + callTool", () => {
  it("聚合所有 ready server 的 tools 并标识 server 名", async () => {
    const mgr = newManager();
    await mgr.start({
      servers: {
        s1: { command: "node", args: [FAKE_SERVER] },
        s2: { command: "node", args: [FAKE_SERVER] },
      },
    });
    const tools = mgr.listAllTools();
    expect(tools.length).toBe(8); // 2 server × 4 tool
    const counts = tools.reduce((acc, t) => {
      acc[t.server] = (acc[t.server] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    expect(counts).toEqual({ s1: 4, s2: 4 });
  });

  it("callTool 转发到指定 server", async () => {
    const mgr = newManager();
    await mgr.start({ servers: { s1: { command: "node", args: [FAKE_SERVER] } } });
    const r = await mgr.callTool("s1", "echo", { text: "yo" });
    expect(r.content[0]).toMatchObject({ type: "text", text: "yo" });
  });

  it("callTool 未知 server → 抛错", async () => {
    const mgr = newManager();
    await mgr.start({ servers: {} });
    await expect(mgr.callTool("missing", "echo", {})).rejects.toThrow(/unknown mcp server/);
  });

  it("callTool 在 not-ready server 上 → 抛错", async () => {
    const mgr = newManager();
    await mgr.start({
      servers: { bad: { command: "/no/such/binary-zzz" } },
    });
    await expect(mgr.callTool("bad", "echo", {})).rejects.toThrow(/not ready/);
  });
});

describe("McpManager autoRestart + closeAll", () => {
  it("server 崩溃后自动重启（backoff 1s 后回到 ready）", async () => {
    const mgr = newManager();
    await mgr.start({ servers: { s1: { command: "node", args: [FAKE_SERVER] } } });
    expect(mgr.isReady("s1")).toBe(true);

    // 触发 crash
    await expect(mgr.callTool("s1", "crash", {})).rejects.toThrow();

    // 立即检查应已离线
    await new Promise((r) => setTimeout(r, 50));
    expect(mgr.isReady("s1")).toBe(false);
    const snap1 = mgr.listServers().find((s) => s.name === "s1");
    expect(snap1?.status).toBe("restart-pending");

    // 等 backoff (1s) + spawn 时间
    await new Promise((r) => setTimeout(r, 1500));
    expect(mgr.isReady("s1")).toBe(true);
    const snap2 = mgr.listServers().find((s) => s.name === "s1");
    expect(snap2?.restartCount).toBeGreaterThan(0);
  }, 8000);

  it("closeAll 后不再触发 restart", async () => {
    const mgr = newManager();
    await mgr.start({ servers: { s1: { command: "node", args: [FAKE_SERVER] } } });
    await mgr.closeAll();
    // 重启 timer 应该被清理
    await new Promise((r) => setTimeout(r, 100));
    expect(mgr.listServers()).toEqual([]); // closeAll 清空
  });
});

describe("McpManager.addServer", () => {
  it("热加载追加新 server", async () => {
    const mgr = newManager();
    await mgr.start({ servers: {} });
    await mgr.addServer("late", { command: "node", args: [FAKE_SERVER] });
    expect(mgr.isReady("late")).toBe(true);
  });

  it("重名 addServer 抛错", async () => {
    const mgr = newManager();
    await mgr.start({ servers: { s: { command: "node", args: [FAKE_SERVER] } } });
    await expect(
      mgr.addServer("s", { command: "node", args: [FAKE_SERVER] })
    ).rejects.toThrow(/already registered/);
  });
});
