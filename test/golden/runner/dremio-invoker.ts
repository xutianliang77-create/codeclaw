/**
 * Dremio Golden Suite · 调用器
 *
 * 三条路径：
 *   1. Mock：deterministic answer + 假 toolsInvoked，骨架自测
 *   2. Direct MCP：mcpManager.callTool(server, tool, args)，不经 LLM；返回 content[] 拼接文本
 *   3. NL（QueryEngine）：真 LLM + 注入 mcpManager；订阅 tool-start 收 toolName 列表
 *
 * 三条路径 mutually exclusive；runner 按 layer 选路径。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpManager } from "../../../src/mcp/manager";
import { loadMcpConfig } from "../../../src/mcp/config";
import type { DremioQuestion } from "./dremio-types";

export interface DremioInvocation {
  provider?: string;
  modelId?: string;
  answer: string;
  /** L1 直调：[mcp.tool]；L2 走 LLM：实际触发的 tool name 列表（顺序保留） */
  toolsInvoked: string[];
  latencyMs: number;
  /** isError === true（L1 路径） / engine error / 没有任何 content */
  hadError?: boolean;
}

export interface DremioInvoker {
  invoke(question: DremioQuestion): Promise<DremioInvocation>;
  shutdown?(): Promise<void>;
}

// ----- Mock --------------------------------------------------------------

export class MockDremioInvoker implements DremioInvoker {
  async invoke(question: DremioQuestion): Promise<DremioInvocation> {
    const start = Date.now();
    const parts: string[] = [`[mock answer for ${question.id}]`];
    for (const m of question.expected.must_mention ?? []) parts.push(m);
    const answer = parts.join("\n");

    const fakeTools: string[] = [];
    if (question.layer === "L1" && question.mcp) {
      fakeTools.push(`mcp__${question.mcp.server}__${question.mcp.tool}`);
    } else if (question.expected.tool_calls?.must_invoke) {
      // 取 must_invoke 的第一个备选当假 tool 名
      const first = question.expected.tool_calls.must_invoke[0]?.split(/\s*(?:或|\/|\bor\b|\|)\s*/i)[0];
      if (first) fakeTools.push(first.trim());
    }

    await new Promise((r) => setTimeout(r, 5));
    return {
      provider: "mock",
      modelId: "mock-deterministic",
      answer,
      toolsInvoked: fakeTools,
      latencyMs: Date.now() - start,
    };
  }
}

// ----- Real --------------------------------------------------------------

/**
 * 启动 mcpManager（读 ~/.codeclaw/mcp.json 或 .mcp.json），返回 manager + shutdown。
 * 失败 server 不阻塞，启动后会立即可用 listAllTools()。
 */
async function bootMcpManager(workspace: string): Promise<{ manager: McpManager; shutdown: () => Promise<void> }> {
  const manager = new McpManager();
  await manager.start(loadMcpConfig(workspace));
  return {
    manager,
    shutdown: async () => {
      await manager.closeAll().catch(() => undefined);
    },
  };
}

/**
 * 把 McpToolResult.content[] 里的 text 字段拼成单一字符串，方便 scorer 做 substring 匹配。
 */
function flattenContent(content: Array<{ type: string; text?: string; [k: string]: unknown }>): string {
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c.text === "string" && c.text.length > 0) {
      parts.push(c.text);
    } else if (c.type === "text" && typeof c.text === "string") {
      parts.push(c.text);
    } else {
      // 非 text 节点（image/resource）retain JSON snapshot 让 scorer 还能对 type 做 keyword 匹配
      parts.push(JSON.stringify(c));
    }
  }
  return parts.join("\n");
}

/**
 * 真实调用器：L1 走 mcpManager.callTool；L2 走 QueryEngine + LLM。
 */
export class RealDremioInvoker implements DremioInvoker {
  private manager: McpManager;
  private shutdownFn: () => Promise<void>;
  private workspace: string;

  private constructor(manager: McpManager, shutdownFn: () => Promise<void>, workspace: string) {
    this.manager = manager;
    this.shutdownFn = shutdownFn;
    this.workspace = workspace;
  }

  static async create(workspace: string = process.cwd()): Promise<RealDremioInvoker> {
    const { manager, shutdown } = await bootMcpManager(workspace);
    return new RealDremioInvoker(manager, shutdown, workspace);
  }

  serverReady(server: string): boolean {
    return this.manager.isReady(server);
  }

  listToolNames(server: string): string[] {
    return this.manager
      .listAllTools()
      .filter((t) => t.server === server)
      .map((t) => t.tool.name);
  }

  async invoke(question: DremioQuestion): Promise<DremioInvocation> {
    if (question.layer === "L1" || (question.layer === "E" && question.mcp)) {
      return this.invokeDirect(question);
    }
    return this.invokeNatural(question);
  }

  private async invokeDirect(question: DremioQuestion): Promise<DremioInvocation> {
    const start = Date.now();
    const mcp = question.mcp!;
    const fullName = `mcp__${mcp.server}__${mcp.tool}`;
    try {
      if (!this.manager.isReady(mcp.server)) {
        return {
          answer: `[mcp not ready: ${mcp.server}]`,
          toolsInvoked: [fullName],
          latencyMs: Date.now() - start,
          hadError: true,
        };
      }
      const result = await this.manager.callTool(mcp.server, mcp.tool, mcp.args);
      const text = flattenContent(result.content);
      const isError = result.isError === true;
      // expectError=true 时 isError 命中视为正常路径，不标 hadError
      const reportError = isError && !mcp.expectError;
      return {
        provider: "mcp-direct",
        modelId: mcp.server,
        answer: text || "[empty content]",
        toolsInvoked: [fullName],
        latencyMs: Date.now() - start,
        ...(reportError ? { hadError: true } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // expectError=true：抛错也算预期路径，answer 含错误信息让 scorer 匹 401/permission 之类关键词
      return {
        answer: `[mcp call error] ${msg}`,
        toolsInvoked: [fullName],
        latencyMs: Date.now() - start,
        hadError: !mcp.expectError,
      };
    }
  }

  private async invokeNatural(question: DremioQuestion): Promise<DremioInvocation> {
    const start = Date.now();

    const { loadRuntimeSelection } = await import("../../../src/provider/registry");
    const { config, selection } = await loadRuntimeSelection();
    if (!config || !selection || !selection.current) {
      return {
        answer: `[no provider configured; run 'codeclaw setup' first]`,
        toolsInvoked: [],
        latencyMs: Date.now() - start,
        hadError: true,
      };
    }
    const provider = selection.current;

    const { createQueryEngine } = await import("../../../src/agent/queryEngine");
    const sessionsTmp = mkdtempSync(path.join(tmpdir(), "golden-dremio-sess-"));

    let lastNonEmptyAnswer = "";
    const toolsInvoked: string[] = [];
    let hadError = false;

    try {
      const engine = createQueryEngine({
        currentProvider: provider,
        fallbackProvider: null,
        // auto：LLM 可调任何已注册工具；物理上稍后会 unregister 写工具
        permissionMode: "auto",
        workspace: this.workspace,
        channel: "cli",
        userId: "golden-dremio",
        auditDbPath: null,
        dataDbPath: null,
        sessionsDir: sessionsTmp,
        mcpManager: this.manager,
      });

      // 物理只读保护：unregister 所有写/危险工具，只保留 read/glob 系 + 所有 mcp__* 桥接工具
      const reg = (engine as unknown as {
        toolRegistry?: { list(): Array<{ name: string }>; unregister(name: string): boolean };
      }).toolRegistry;
      if (reg) {
        const READ_OK = new Set(["read", "glob", "symbol", "definition", "references", "read_artifact"]);
        for (const t of reg.list()) {
          if (READ_OK.has(t.name)) continue;
          if (t.name.startsWith("mcp__")) continue;
          reg.unregister(t.name);
        }
      }

      for await (const ev of engine.submitMessage(question.prompt)) {
        if (ev.type === "tool-start") {
          const name = (ev as { toolName?: string }).toolName;
          if (typeof name === "string" && name) toolsInvoked.push(name);
        } else if (ev.type === "message-complete") {
          const text = (ev as { text?: string }).text ?? "";
          if (text.trim()) lastNonEmptyAnswer = text;
        }
      }
    } catch (err) {
      lastNonEmptyAnswer = `[engine error] ${err instanceof Error ? err.message : String(err)}`;
      hadError = true;
    } finally {
      try {
        rmSync(sessionsTmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }

    return {
      provider: provider.type,
      modelId: provider.model,
      answer: lastNonEmptyAnswer || "[no content produced]",
      toolsInvoked,
      latencyMs: Date.now() - start,
      ...(hadError ? { hadError: true } : {}),
    };
  }

  async shutdown(): Promise<void> {
    await this.shutdownFn();
  }
}
