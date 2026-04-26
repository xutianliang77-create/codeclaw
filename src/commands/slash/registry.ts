/**
 * Slash 命令注册表（ADR-003）
 *
 * 职责：
 *   - 按 name / alias 注册并去重
 *   - 路由 prompt → command handler（支持精确匹配和"前缀 + 空格"匹配）
 *   - 汇总 /help 文本（分类 + 对齐）
 *
 * 非职责：
 *   - 不执行 handler 的副作用（由 runtime 决定）
 *   - 不处理权限 / 审批（在 handler 内部或 context 上处理）
 */

import type {
  SlashCommand,
  SlashContext,
  SlashResult,
  RegisterConflictPolicy,
  SlashCategory,
} from "./types";

export class SlashRegistry {
  private commands = new Map<string, SlashCommand>();
  /** alias → canonical name 的反查表 */
  private aliasIndex = new Map<string, string>();

  register(cmd: SlashCommand, conflict: RegisterConflictPolicy = "throw"): void {
    const all = [cmd.name, ...(cmd.aliases ?? [])];
    for (const key of all) {
      if (!key.startsWith("/")) {
        throw new Error(`Slash command name must start with '/' (got "${key}")`);
      }
      const lower = key.toLowerCase();
      const existing = this.commands.get(lower) ?? this.resolveAliased(lower);
      if (existing) {
        if (conflict === "throw") {
          throw new Error(
            `Slash command conflict: "${lower}" already registered as "${existing.name}"`
          );
        }
        if (conflict === "skip") return;
        // overwrite: 先拆掉旧的
        this.unregister(existing.name);
      }
    }

    const canonical = cmd.name.toLowerCase();
    this.commands.set(canonical, { ...cmd, name: canonical });
    for (const alias of cmd.aliases ?? []) {
      this.aliasIndex.set(alias.toLowerCase(), canonical);
    }
  }

  unregister(name: string): boolean {
    const canonical = name.toLowerCase();
    const cmd = this.commands.get(canonical);
    if (!cmd) return false;
    this.commands.delete(canonical);
    for (const alias of cmd.aliases ?? []) {
      this.aliasIndex.delete(alias.toLowerCase());
    }
    return true;
  }

  /** 按 prompt 查找命令。不负责执行，只返回匹配信息。 */
  match(prompt: string): {
    command: SlashCommand;
    argsRaw: string;
    argv: string[];
  } | null {
    const trimmed = prompt.trimStart();
    if (!trimmed.startsWith("/")) return null;

    // 取第一个 token（`/mode foo bar` → `/mode`）
    const spaceIdx = trimmed.search(/\s/);
    const head = (spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
    const rest = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : "";

    const command = this.resolveAliased(head);
    if (!command) return null;

    const argv = rest.length > 0 ? rest.split(/\s+/) : [];
    return { command, argsRaw: rest, argv };
  }

  /** 运行命令（匹配 + 调 handler）。未命中返回 null。 */
  async dispatch(
    prompt: string,
    queryEngine: unknown
  ): Promise<{ command: SlashCommand; result: SlashResult } | null> {
    const m = this.match(prompt);
    if (!m) return null;

    const ctx: SlashContext = {
      rawPrompt: prompt,
      commandName: m.command.name,
      argsRaw: m.argsRaw,
      argv: m.argv,
      queryEngine,
    };

    const result = await m.command.handler(ctx);
    return { command: m.command, result };
  }

  list(): SlashCommand[] {
    return [...this.commands.values()];
  }

  listByCategory(category: SlashCategory): SlashCommand[] {
    return this.list().filter((c) => c.category === category);
  }

  get(name: string): SlashCommand | undefined {
    return this.resolveAliased(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** 生成 /help 文本。按 category 分组，长度对齐。 */
  generateHelp(): string {
    const byCat = new Map<SlashCategory, SlashCommand[]>();
    for (const cmd of this.list()) {
      const arr = byCat.get(cmd.category) ?? [];
      arr.push(cmd);
      byCat.set(cmd.category, arr);
    }

    const order: SlashCategory[] = [
      "session",
      "permission",
      "observability",
      "memory",
      "provider",
      "plugin",
      "integration",
      "workflow",
      "help",
    ];

    const lines: string[] = [];
    lines.push("Available commands (slash):");
    for (const cat of order) {
      const cmds = byCat.get(cat);
      if (!cmds || cmds.length === 0) continue;
      cmds.sort((a, b) => a.name.localeCompare(b.name));
      const width = Math.max(...cmds.map((c) => c.name.length));
      lines.push(`\n[${cat}]`);
      for (const c of cmds) {
        lines.push(`  ${c.name.padEnd(width)}  ${c.summary}`);
      }
    }
    return lines.join("\n");
  }

  private resolveAliased(key: string): SlashCommand | undefined {
    const direct = this.commands.get(key);
    if (direct) return direct;
    const canonical = this.aliasIndex.get(key);
    return canonical ? this.commands.get(canonical) : undefined;
  }
}

/** 便捷工厂：给一个快速注册函数 */
export function defineCommand(cmd: SlashCommand): SlashCommand {
  return cmd;
}

/** 给 handler 快速拼 reply 的糖 */
export function reply(text: string): SlashResult {
  return { kind: "reply", text };
}

export const noop: SlashResult = { kind: "noop" };
export const passthrough: SlashResult = { kind: "passthrough" };
