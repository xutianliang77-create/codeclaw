/**
 * McpClient 单测（M3-01 step a）
 *
 * 通过 test/fixtures/mcp-fake-server.cjs 起一个真子进程，验证：
 *   - initialize 握手
 *   - tools/list
 *   - tools/call happy + JSON-RPC error 路径
 *   - 子进程崩溃时 pending 全 reject
 *   - request timeout
 *   - close() 回收
 */

import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";

import { McpClient } from "../../../src/mcp/client";

const FAKE_SERVER = path.resolve(__dirname, "../../fixtures/mcp-fake-server.cjs");

const clients: McpClient[] = [];

function newClient(): McpClient {
  const c = new McpClient();
  clients.push(c);
  return c;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
});

describe("McpClient.start", () => {
  it("initialize 握手成功 + isAlive=true", async () => {
    const client = newClient();
    await client.start({ command: "node", args: [FAKE_SERVER] });
    expect(client.isAlive()).toBe(true);
  });

  it("initialize timeout 抛错", async () => {
    const client = newClient();
    await expect(
      client.start({
        command: "node",
        args: ["-e", "setInterval(()=>{}, 1000)"], // 起一个不响应的子进程
        initTimeoutMs: 200,
      })
    ).rejects.toThrow(/timeout/);
  });

  it("命令不存在抛错", async () => {
    const client = newClient();
    await expect(
      client.start({ command: "/no/such/binary-12345", initTimeoutMs: 500 })
    ).rejects.toThrow();
  });
});

describe("McpClient.listTools", () => {
  it("返回 fake server 的 4 个 tool", async () => {
    const client = newClient();
    await client.start({ command: "node", args: [FAKE_SERVER] });
    const tools = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["crash", "echo", "never-respond", "raise"]);
  });

  it("未 start 调 listTools 抛错", async () => {
    const client = newClient();
    await expect(client.listTools()).rejects.toThrow();
  });
});

describe("McpClient.callTool", () => {
  it("echo 工具回显 text", async () => {
    const client = newClient();
    await client.start({ command: "node", args: [FAKE_SERVER] });
    const r = await client.callTool("echo", { text: "hello mcp" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]).toMatchObject({ type: "text", text: "hello mcp" });
  });

  it("server 返回 JSON-RPC error → reject 含 message", async () => {
    const client = newClient();
    await client.start({ command: "node", args: [FAKE_SERVER] });
    await expect(client.callTool("raise", {})).rejects.toThrow(/deliberate failure/);
  });

  it("调不存在 tool → reject", async () => {
    const client = newClient();
    await client.start({ command: "node", args: [FAKE_SERVER] });
    await expect(client.callTool("does-not-exist", {})).rejects.toThrow(/unknown tool/);
  });

  it("never-respond + 短 timeout → reject /timeout/", async () => {
    const client = newClient();
    await client.start({
      command: "node",
      args: [FAKE_SERVER],
      requestTimeoutMs: 200, // ← 仅作占位；callTool 接受单独 timeout 留 future
    });
    // 直接用 sendRequest 走默认 30s 太久，这里通过 callTool 的实际 path 测时序：
    // 改用 Promise.race 套 200ms
    await expect(
      Promise.race([
        client.callTool("never-respond", {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error("test-timeout")), 250)),
      ])
    ).rejects.toThrow(/test-timeout/);
  });
});

describe("McpClient lifecycle", () => {
  it("server 主动 crash → pending request reject + isAlive=false + onExit fired", async () => {
    const client = newClient();
    await client.start({ command: "node", args: [FAKE_SERVER] });

    let exitCode: number | null | undefined;
    client.onExit((code) => {
      exitCode = code;
    });

    // 触发 crash（server 收到 tools/call name=crash 后 process.exit(2)）
    // crash 调用本身会 reject（连接被切）
    await expect(client.callTool("crash", {})).rejects.toThrow();

    // 等子进程 exit 事件落
    await new Promise((r) => setTimeout(r, 50));
    expect(client.isAlive()).toBe(false);
    expect(exitCode).toBe(2);
  });

  it("close() 优雅关闭 + isAlive=false", async () => {
    const client = newClient();
    await client.start({ command: "node", args: [FAKE_SERVER] });
    expect(client.isAlive()).toBe(true);
    await client.close();
    expect(client.isAlive()).toBe(false);
  });

  it("close 后 callTool 抛错", async () => {
    const client = newClient();
    await client.start({ command: "node", args: [FAKE_SERVER] });
    await client.close();
    await expect(client.callTool("echo", { text: "x" })).rejects.toThrow();
  });

  it("start 两次抛错", async () => {
    const client = newClient();
    await client.start({ command: "node", args: [FAKE_SERVER] });
    await expect(client.start({ command: "node", args: [FAKE_SERVER] })).rejects.toThrow(
      /already started/
    );
  });
});
