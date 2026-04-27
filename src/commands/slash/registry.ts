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

  /**
   * P4.5：prompt 看起来像 slash 命令但未匹配 → 给 did-you-mean 提示。
   *
   * 触发条件：trimmed 以 / 开头 + 第一段是 \w+（字母数字下划线连字符）+ 不含 space 之前不是已注册命令
   * - Levenshtein ≤ 2 → 给最近 1-3 个候选
   * - 距离 > 2 → 提示 /help 列表
   * - 未触发（不像 slash 命令）返 null，由调用方放行 LLM
   */
  suggestForUnknown(prompt: string): string | null {
    const trimmed = prompt.trimStart();
    if (!trimmed.startsWith("/")) return null;

    const spaceIdx = trimmed.search(/\s/);
    const head = (spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
    // 第一段必须是 word-like：/foo / /foo-bar / /foo_bar OK；/$bar 不触发
    if (!/^\/[\w-]+$/.test(head)) return null;

    // 已经匹配了就不该走这里
    if (this.resolveAliased(head)) return null;

    // 收集所有命令名 + alias
    const allNames = new Set<string>();
    for (const cmd of this.commands.values()) {
      allNames.add(cmd.name.toLowerCase());
      if (cmd.aliases) {
        for (const a of cmd.aliases) allNames.add(a.toLowerCase());
      }
    }

    const candidates: Array<{ name: string; dist: number }> = [];
    for (const n of allNames) {
      const d = levenshtein(head, n);
      if (d <= 2) {
        candidates.push({ name: n, dist: d });
      }
    }
    candidates.sort((a, b) => a.dist - b.dist || a.name.localeCompare(b.name));

    if (candidates.length === 0) {
      return `Unknown command "${head}". Type /help to list available commands.\n未知命令 "${head}"。输入 /help 查看可用命令。`;
    }
    const top = candidates.slice(0, 3).map((c) => c.name);
    return (
      `Unknown command "${head}". Did you mean: ${top.join(", ")}?\n` +
      `未知命令 "${head}"。是不是想用：${top.join(", ")}？`
    );
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
        // P6b：summaryZh 存在时拼「英 · 中」并排；不存在则只显示英文
        const summaryDisplay = c.summaryZh ? `${c.summary}  ·  ${c.summaryZh}` : c.summary;
        lines.push(`  ${c.name.padEnd(width)}  ${summaryDisplay}`);
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

/**
 * 简单 Levenshtein 距离（用于 /skill → /skills 这类 typo 提示）。
 * 字符串通常 < 20 字符，O(mn) 足够。
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** 给 handler 快速拼 reply 的糖 */
export function reply(text: string): SlashResult {
  return { kind: "reply", text };
}

export const noop: SlashResult = { kind: "noop" };
export const passthrough: SlashResult = { kind: "passthrough" };
