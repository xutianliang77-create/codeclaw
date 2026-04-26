/**
 * McpManager · 多 server 生命周期 + autoRestart（M3-01 step b）
 *
 * 职责：
 *   - 按 McpConfig 并发 spawn 所有 enabled server
 *   - 每个 server 失败启动不阻塞其他 server（best-effort）
 *   - 子进程崩溃 → 指数退避重启（1s → 2s → 4s → 8s → 16s 上限），最多 MAX_RESTARTS 次
 *   - 主动 closeAll 时不再触发 restart（标记 shuttingDown）
 *   - 提供 listAllTools()：聚合所有 alive server 的 tools，附带 server 名（不重命名）
 *   - 提供 callTool(server, tool, args)：转发给对应 client
 *
 * 调用层（M3-01 step c 桥接 ToolRegistry）会用 listAllTools + callTool 把 MCP 工具
 * namespace 化（"<server>:<tool>"）注册进 ToolRegistry，本类只管原始 (server, tool) 维度。
 */

import { McpClient, type McpClientOptions, type McpToolDescriptor, type McpToolResult } from "./client";
import type { McpConfig, McpServerConfig } from "./config";

const MAX_RESTARTS = 5;
const RESTART_BACKOFFS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

export interface McpServerSnapshot {
  name: string;
  status: "starting" | "ready" | "exited" | "failed" | "restart-pending";
  toolCount: number;
  restartCount: number;
  lastError?: string;
  lastExitCode?: number | null;
  lastExitSignal?: string | null;
}

interface ServerEntry {
  name: string;
  config: McpServerConfig;
  client: McpClient | null;
  status: McpServerSnapshot["status"];
  tools: McpToolDescriptor[];
  restartCount: number;
  restartTimer: NodeJS.Timeout | null;
  lastError?: string;
  lastExitCode?: number | null;
  lastExitSignal?: string | null;
}

export class McpManager {
  private servers = new Map<string, ServerEntry>();
  private shuttingDown = false;

  /** 启动 config 中所有非 disabled server。failed server 不阻塞返回。 */
  async start(config: McpConfig): Promise<void> {
    this.shuttingDown = false;
    const startups = Object.entries(config.servers)
      .filter(([, cfg]) => cfg.disabled !== true)
      .map(([name, cfg]) => this.bootstrap(name, cfg));
    await Promise.all(startups);
  }

  /** 按需补充一个 server（如 /mcp slash 命令热加载未来扩展）。 */
  async addServer(name: string, cfg: McpServerConfig): Promise<void> {
    if (this.servers.has(name)) {
      throw new Error(`mcp server already registered: ${name}`);
    }
    await this.bootstrap(name, cfg);
  }

  listServers(): McpServerSnapshot[] {
    return Array.from(this.servers.values())
      .map((e) => ({
        name: e.name,
        status: e.status,
        toolCount: e.tools.length,
        restartCount: e.restartCount,
        ...(e.lastError ? { lastError: e.lastError } : {}),
        ...(e.lastExitCode !== undefined ? { lastExitCode: e.lastExitCode } : {}),
        ...(e.lastExitSignal !== undefined ? { lastExitSignal: e.lastExitSignal } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  listAllTools(): Array<{ server: string; tool: McpToolDescriptor }> {
    const out: Array<{ server: string; tool: McpToolDescriptor }> = [];
    for (const e of this.servers.values()) {
      if (e.status !== "ready") continue;
      for (const t of e.tools) out.push({ server: e.name, tool: t });
    }
    return out;
  }

  hasServer(name: string): boolean {
    return this.servers.has(name);
  }

  isReady(serverName: string): boolean {
    return this.servers.get(serverName)?.status === "ready";
  }

  async callTool(serverName: string, toolName: string, args: unknown): Promise<McpToolResult> {
    const entry = this.servers.get(serverName);
    if (!entry) throw new Error(`unknown mcp server: ${serverName}`);
    if (entry.status !== "ready" || !entry.client) {
      throw new Error(`mcp server not ready: ${serverName} (status=${entry.status})`);
    }
    return entry.client.callTool(toolName, args);
  }

  async closeAll(): Promise<void> {
    this.shuttingDown = true;
    const closes: Promise<void>[] = [];
    for (const e of this.servers.values()) {
      if (e.restartTimer) {
        clearTimeout(e.restartTimer);
        e.restartTimer = null;
      }
      if (e.client) closes.push(e.client.close().catch(() => undefined));
    }
    await Promise.all(closes);
    this.servers.clear();
  }

  private async bootstrap(name: string, cfg: McpServerConfig): Promise<void> {
    const entry: ServerEntry = {
      name,
      config: cfg,
      client: null,
      status: "starting",
      tools: [],
      restartCount: 0,
      restartTimer: null,
    };
    this.servers.set(name, entry);
    await this.spawnAndInit(entry);
  }

  private async spawnAndInit(entry: ServerEntry): Promise<void> {
    entry.status = "starting";
    entry.lastError = undefined;
    const client = new McpClient();
    const opts: McpClientOptions = {
      command: entry.config.command,
      ...(entry.config.args ? { args: entry.config.args } : {}),
      ...(entry.config.env ? { env: entry.config.env } : {}),
      ...(entry.config.cwd ? { cwd: entry.config.cwd } : {}),
    };
    client.onExit((code, signal) => this.handleClientExit(entry, code, signal));
    try {
      await client.start(opts);
      const tools = await client.listTools();
      entry.client = client;
      entry.tools = tools;
      entry.status = "ready";
    } catch (err) {
      entry.lastError = err instanceof Error ? err.message : String(err);
      entry.status = "failed";
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      entry.client = null;
    }
  }

  private handleClientExit(
    entry: ServerEntry,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    entry.lastExitCode = code;
    entry.lastExitSignal = signal;
    entry.client = null;
    entry.tools = [];
    entry.status = "exited";

    if (this.shuttingDown) return;
    if (entry.restartCount >= MAX_RESTARTS) {
      entry.status = "failed";
      entry.lastError = `restart limit reached (${MAX_RESTARTS})`;
      return;
    }

    const delayMs = RESTART_BACKOFFS_MS[Math.min(entry.restartCount, RESTART_BACKOFFS_MS.length - 1)];
    entry.restartCount += 1;
    entry.status = "restart-pending";
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      if (this.shuttingDown) return;
      void this.spawnAndInit(entry);
    }, delayMs);
  }
}
