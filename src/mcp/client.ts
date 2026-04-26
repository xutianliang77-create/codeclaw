/**
 * MCP Client · stdio JSON-RPC 2.0 over child process（M3-01 step a）
 *
 * 协议：
 *   - 透传规范见 https://spec.modelcontextprotocol.io/specification/
 *   - stdio transport：stdin/stdout 上行/下行 newline-delimited JSON 消息
 *   - JSON-RPC 2.0：请求带 id，响应按 id 关联；通知无 id
 *   - 握手：client → initialize（capabilities + protocolVersion）→ server 响应 →
 *           client → notifications/initialized（通知，无回复）
 *
 * 不变量：
 *   - 单个 client 实例对应单个子进程；start() 只调一次
 *   - 子进程 stderr 转 process.stderr 加前缀（mcp servers 习惯走 stderr 打日志）
 *   - 子进程退出时所有 pending request 立即 reject（不留悬挂 promise）
 *
 * 不在本步范围（M3-01 b/c/d）：
 *   - autoRestart 退出后重启
 *   - 多 client 管理（McpManager）
 *   - 桥接 ToolRegistry
 *   - server → client 反向请求 / sampling / 资源订阅
 */

import { ChildProcess, spawn } from "node:child_process";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
}

export interface McpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  initTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_INIT_TIMEOUT = 10_000;
const DEFAULT_REQUEST_TIMEOUT = 30_000;
const SHUTDOWN_KILL_GRACE_MS = 1_000;
const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "codeclaw", version: "0.5.0" };

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class McpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private stdoutBuffer = "";
  private exited = false;
  private initialized = false;
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private label = "mcp";

  async start(opts: McpClientOptions): Promise<void> {
    if (this.child) {
      throw new Error("mcp client already started");
    }
    this.label = `mcp:${opts.command.split("/").pop()}`;
    const child = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.handleStdoutChunk(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[${this.label}] ${chunk.toString("utf8")}`);
    });
    child.on("exit", (code, signal) => this.handleExit(code, signal));
    child.on("error", (err) => this.handleSpawnError(err));

    await this.sendRequest(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT
    );
    this.sendNotification("notifications/initialized");
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    this.assertReady();
    const result = await this.sendRequest("tools/list");
    if (!result || typeof result !== "object") return [];
    const tools = (result as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) return [];
    return tools as McpToolDescriptor[];
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    this.assertReady();
    const result = await this.sendRequest("tools/call", {
      name,
      arguments: args ?? {},
    });
    if (!result || typeof result !== "object") {
      return { content: [], isError: true };
    }
    const content = (result as { content?: unknown }).content;
    return {
      content: Array.isArray(content) ? (content as McpToolResult["content"]) : [],
      isError: (result as { isError?: boolean }).isError === true,
    };
  }

  async close(): Promise<void> {
    if (!this.child) return;
    if (this.exited) {
      this.child = null;
      return;
    }
    const child = this.child;
    try {
      this.sendNotification("notifications/shutdown");
    } catch {
      /* best effort */
    }
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, SHUTDOWN_KILL_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
    this.child = null;
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }

  isAlive(): boolean {
    return this.child !== null && !this.exited;
  }

  private assertReady(): void {
    if (this.exited) throw new Error("mcp client has exited");
    if (!this.initialized) throw new Error("mcp client not initialized");
    if (!this.child) throw new Error("mcp client not started");
  }

  private async sendRequest(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<unknown> {
    if (this.exited || !this.child) {
      throw new Error("mcp client not running");
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const timeout = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp request timeout (${timeout}ms): ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeMessage(req);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    if (this.exited || !this.child) return;
    const note: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.writeMessage(note);
  }

  private writeMessage(msg: unknown): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error("mcp child stdin closed");
    }
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  private handleStdoutChunk(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        process.stderr.write(`[${this.label}] parse error: ${trimmed.slice(0, 200)}\n`);
        continue;
      }
      this.dispatchMessage(msg);
    }
  }

  private dispatchMessage(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const m = msg as Partial<JsonRpcResponse>;
    if (typeof m.id !== "number") {
      // notification or server-side request；当前不处理（M3-01 范围外）
      return;
    }
    const entry = this.pending.get(m.id);
    if (!entry) return;
    this.pending.delete(m.id);
    clearTimeout(entry.timer);
    if (m.error) {
      entry.reject(new Error(`mcp error ${m.error.code}: ${m.error.message}`));
      return;
    }
    entry.resolve(m.result);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    this.failAllPending(new Error(`mcp client exited (code=${code}, signal=${signal})`));
    for (const listener of this.exitListeners) {
      try {
        listener(code, signal);
      } catch {
        /* swallow listener error */
      }
    }
  }

  private handleSpawnError(err: Error): void {
    this.exited = true;
    this.failAllPending(err);
  }

  private failAllPending(err: Error): void {
    const remaining = [...this.pending.values()];
    this.pending.clear();
    for (const entry of remaining) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }
}
