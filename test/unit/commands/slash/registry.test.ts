/**
 * Slash Registry 单测（P0-W2-01）
 */

import { describe, expect, it } from "vitest";
import { SlashRegistry, defineCommand, reply } from "../../../../src/commands/slash/registry";

function echoCommand(name: string, aliases?: string[]) {
  return defineCommand({
    name,
    aliases,
    category: "help",
    risk: "low",
    summary: `echo ${name}`,
    handler: (ctx) => reply(`echo:${ctx.commandName}:${ctx.argsRaw}`),
  });
}

describe("SlashRegistry.register", () => {
  it("accepts a new command with aliases", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo", ["/f"]));
    expect(reg.has("/foo")).toBe(true);
    expect(reg.has("/f")).toBe(true);
    expect(reg.get("/F")!.name).toBe("/foo"); // case-insensitive
  });

  it("throws on conflict by default", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo"));
    expect(() => reg.register(echoCommand("/foo"))).toThrow(/conflict/);
  });

  it("skips on conflict when policy=skip", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo"));
    reg.register(echoCommand("/foo"), "skip");
    expect(reg.list()).toHaveLength(1);
  });

  it("overwrites on conflict when policy=overwrite", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo", ["/old"]));
    reg.register(
      defineCommand({
        name: "/foo",
        aliases: ["/new"],
        category: "help",
        risk: "low",
        summary: "replacement",
        handler: () => reply("new"),
      }),
      "overwrite"
    );
    expect(reg.get("/foo")!.summary).toBe("replacement");
    expect(reg.has("/old")).toBe(false);
    expect(reg.has("/new")).toBe(true);
  });

  it("rejects names without slash prefix", () => {
    const reg = new SlashRegistry();
    expect(() =>
      reg.register(
        defineCommand({
          name: "bad",
          category: "help",
          risk: "low",
          summary: "no slash",
          handler: () => reply(""),
        })
      )
    ).toThrow(/start with/);
  });

  it("rejects alias conflict against an existing name", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo"));
    expect(() => reg.register(echoCommand("/bar", ["/foo"]))).toThrow(/conflict/);
  });
});

describe("SlashRegistry.match / dispatch", () => {
  it("matches exact command", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo"));
    const m = reg.match("/foo");
    expect(m?.command.name).toBe("/foo");
    expect(m?.argsRaw).toBe("");
    expect(m?.argv).toEqual([]);
  });

  it("matches command + args", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo"));
    const m = reg.match("/foo  hello world ");
    expect(m?.command.name).toBe("/foo");
    expect(m?.argsRaw).toBe("hello world");
    expect(m?.argv).toEqual(["hello", "world"]);
  });

  it("matches via alias", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo", ["/f"]));
    const m = reg.match("/f bar");
    expect(m?.command.name).toBe("/foo");
    expect(m?.argsRaw).toBe("bar");
  });

  it("returns null when prompt is not a command", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo"));
    expect(reg.match("hello /foo")).toBeNull();
    expect(reg.match("foo")).toBeNull();
    expect(reg.match("")).toBeNull();
  });

  it("returns null when no command matches", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo"));
    expect(reg.match("/bar baz")).toBeNull();
  });

  it("does NOT match prefix without space boundary", () => {
    // /foobar should NOT hit /foo
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo"));
    expect(reg.match("/foobar")).toBeNull();
  });

  it("dispatch runs handler and returns result", async () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo"));
    const out = await reg.dispatch("/foo hi", null);
    expect(out?.command.name).toBe("/foo");
    expect(out?.result).toEqual({ kind: "reply", text: "echo:/foo:hi" });
  });

  it("dispatch returns null on miss", async () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo"));
    expect(await reg.dispatch("/nope", null)).toBeNull();
  });
});

describe("SlashRegistry.generateHelp", () => {
  it("groups by category and aligns", () => {
    const reg = new SlashRegistry();
    reg.register(
      defineCommand({
        name: "/status",
        category: "session",
        risk: "low",
        summary: "Show session status",
        handler: () => reply(""),
      })
    );
    reg.register(
      defineCommand({
        name: "/doctor",
        category: "observability",
        risk: "low",
        summary: "Diagnose environment",
        handler: () => reply(""),
      })
    );
    const help = reg.generateHelp();
    expect(help).toContain("Available commands");
    expect(help).toContain("[session]");
    expect(help).toContain("[observability]");
    expect(help).toContain("/status");
    expect(help).toContain("Show session status");
    // session 段应在 observability 段之前（预定分组顺序）
    expect(help.indexOf("[session]")).toBeLessThan(help.indexOf("[observability]"));
  });

  it("omits empty categories", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo"));
    const help = reg.generateHelp();
    expect(help).not.toContain("[session]"); // no session commands
    expect(help).toContain("[help]");
  });

  it("P6b: summaryZh 存在时拼成双语", () => {
    const reg = new SlashRegistry();
    reg.register(
      defineCommand({
        name: "/foo",
        category: "help",
        risk: "low",
        summary: "Do foo.",
        summaryZh: "做 foo",
        handler: () => reply("x"),
      })
    );
    const help = reg.generateHelp();
    expect(help).toContain("Do foo.");
    expect(help).toContain("做 foo");
    expect(help).toContain("·"); // 中点分隔
  });

  it("P6b: 无 summaryZh 时只显英文（向后兼容）", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/legacy"));
    const help = reg.generateHelp();
    expect(help).toContain("echo /legacy");
    expect(help).not.toContain(" · "); // 没双语并排
  });
});

describe("SlashRegistry.suggestForUnknown (P4.5)", () => {
  it("/skill (typo of /skills) → 推荐 /skills", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/skills"));
    const out = reg.suggestForUnknown("/skill");
    expect(out).toContain('Unknown command "/skill"');
    expect(out).toContain("/skills");
  });

  it("/cro (距离 2) → 推荐 /cron", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/cron"));
    const out = reg.suggestForUnknown("/cro");
    expect(out).toContain("/cron");
  });

  it("距离 > 2 → 提示 /help", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/cron"));
    const out = reg.suggestForUnknown("/foobarbaz");
    expect(out).toContain("/help");
  });

  it("已注册的命令 → null（不应误触发）", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo"));
    expect(reg.suggestForUnknown("/foo")).toBeNull();
  });

  it("非 slash 形态 prompt → null（不拦 LLM）", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/foo"));
    expect(reg.suggestForUnknown("hello world")).toBeNull();
    expect(reg.suggestForUnknown("/foo bar")).toBeNull(); // 第一段是已注册
    expect(reg.suggestForUnknown("/$invalid")).toBeNull(); // 非 word
  });

  it("alias 也参与匹配", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/cron", ["/schedule"]));
    const out = reg.suggestForUnknown("/scedule"); // typo of alias
    expect(out).toContain("/schedule");
  });

  it("命中多个候选时取距离最近的前 3", () => {
    const reg = new SlashRegistry();
    reg.register(echoCommand("/skill"));
    reg.register(echoCommand("/skills"));
    reg.register(echoCommand("/skull")); // 1 字差
    const out = reg.suggestForUnknown("/skil");
    // /skill (dist 1) /skills (dist 2) /skull (dist 2) all ≤ 2
    expect(out).toContain("/skill");
  });
});
