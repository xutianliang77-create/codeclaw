#!/usr/bin/env node
/**
 * Fake MCP server for unit tests · stdio JSON-RPC 2.0
 *
 * 支持的方法（够测 client.ts 全部 happy + 错误 path）：
 *   - initialize          → 返回固定 capabilities
 *   - tools/list          → 返回 [echo, crash, never-respond]
 *   - tools/call name=echo         → 回显 arguments.text
 *   - tools/call name=crash        → server 立即 process.exit(2)
 *   - tools/call name=never-respond → 收到但不回（用来测 timeout）
 *   - tools/call name=raise        → 返回 JSON-RPC error
 *   - 任何其他方法 → 返回 method-not-found error
 *
 * 启动方式：node test/fixtures/mcp-fake-server.cjs
 */

const readline = require("node:readline");

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0" },
      },
    });
    return;
  }

  if (msg.method === "notifications/initialized" || msg.method === "notifications/shutdown") {
    return;
  }

  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "echo arguments.text back",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          { name: "crash", description: "crash the server" },
          { name: "never-respond", description: "for timeout test" },
          { name: "raise", description: "return jsonrpc error" },
        ],
      },
    });
    return;
  }

  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (name === "echo") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: String(args.text ?? "") }] },
      });
      return;
    }
    if (name === "crash") {
      process.exit(2);
    }
    if (name === "never-respond") {
      return;
    }
    if (name === "raise") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "deliberate failure" },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `unknown tool: ${name}` },
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32601, message: `method not found: ${msg.method}` },
  });
});
