/**
 * /cron 命令参数解析单测（#116 step C.4）
 */

import { describe, expect, it } from "vitest";

import { parseCronArgs, tokenize } from "../../../src/cron/cliParse";

describe("tokenize", () => {
  it("普通空白切分", () => {
    expect(tokenize("a b c")).toEqual(["a", "b", "c"]);
  });
  it("双引号包含空格", () => {
    expect(tokenize('add "rag daily" "0 2 * * *"')).toEqual([
      "add",
      "rag daily",
      "0 2 * * *",
    ]);
  });
  it("单引号", () => {
    expect(tokenize("add 'a b' c")).toEqual(["add", "a b", "c"]);
  });
  it("反斜杠转义", () => {
    expect(tokenize('a\\ b c')).toEqual(["a b", "c"]);
  });
});

describe("parseCronArgs - list / help", () => {
  it("空 → list", () => {
    expect(parseCronArgs("")).toEqual({ kind: "list" });
  });
  it("'list' → list", () => {
    expect(parseCronArgs("list")).toEqual({ kind: "list" });
  });
  it("help → help", () => {
    expect(parseCronArgs("help")).toEqual({ kind: "help" });
  });
});

describe("parseCronArgs - add", () => {
  it("最简：name + schedule + slash:/cmd", () => {
    const r = parseCronArgs('add rag-daily "0 2 * * *" slash:/rag\\ index');
    expect(r).toEqual({
      kind: "add",
      name: "rag-daily",
      schedule: "0 2 * * *",
      taskKind: "slash",
      payload: "/rag index",
      notify: [],
    });
  });

  it("带 --notify=cli,wechat", () => {
    const r = parseCronArgs(
      'add weekly "0 9 * * 1" prompt:"review repo" --notify=cli,wechat'
    );
    if (r.kind !== "add") throw new Error("expect add");
    expect(r.taskKind).toBe("prompt");
    expect(r.payload).toBe("review repo");
    expect(r.notify).toEqual(["cli", "wechat"]);
  });

  it("shell 含空格 payload 用引号包整段", () => {
    const r = parseCronArgs('add audit "@hourly" "shell:npm audit --production"');
    if (r.kind !== "add") throw new Error("expect add");
    expect(r.taskKind).toBe("shell");
    expect(r.payload).toBe("npm audit --production");
  });

  it("--timeout=10m", () => {
    const r = parseCronArgs('add x "@hourly" shell:date --timeout=10m');
    if (r.kind !== "add") throw new Error("expect add");
    expect(r.timeoutMs).toBe(10 * 60_000);
  });

  it("--timeout=30s", () => {
    const r = parseCronArgs('add x "@hourly" shell:date --timeout=30s');
    if (r.kind !== "add") throw new Error("expect add");
    expect(r.timeoutMs).toBe(30_000);
  });

  it("非法 kind", () => {
    expect(() => parseCronArgs('add x "@hourly" badkind:foo')).toThrow();
  });

  it("payload 为空", () => {
    expect(() => parseCronArgs('add x "@hourly" slash:')).toThrow();
  });

  it("缺位置参数", () => {
    expect(() => parseCronArgs("add only-name")).toThrow();
  });

  it("非法 notify 通道", () => {
    expect(() =>
      parseCronArgs('add x "@hourly" shell:date --notify=telegram')
    ).toThrow();
  });
});

describe("parseCronArgs - remove/enable/disable/run-now", () => {
  it("remove <id>", () => {
    expect(parseCronArgs("remove abc")).toEqual({ kind: "remove", target: "abc" });
  });
  it("rm 别名", () => {
    expect(parseCronArgs("rm abc")).toEqual({ kind: "remove", target: "abc" });
  });
  it("enable", () => {
    expect(parseCronArgs("enable my-task")).toEqual({
      kind: "enable",
      target: "my-task",
    });
  });
  it("disable", () => {
    expect(parseCronArgs("disable my-task")).toEqual({
      kind: "disable",
      target: "my-task",
    });
  });
  it("run-now / run", () => {
    expect(parseCronArgs("run-now my-task")).toEqual({
      kind: "run-now",
      target: "my-task",
    });
    expect(parseCronArgs("run abc")).toEqual({ kind: "run-now", target: "abc" });
  });
  it("缺 target 抛错", () => {
    expect(() => parseCronArgs("remove")).toThrow();
    expect(() => parseCronArgs("enable")).toThrow();
  });
});

describe("parseCronArgs - logs", () => {
  it("默认 tail=20", () => {
    expect(parseCronArgs("logs my-task")).toEqual({
      kind: "logs",
      target: "my-task",
      tail: 20,
    });
  });

  it("--tail=5", () => {
    expect(parseCronArgs("logs my-task --tail=5")).toEqual({
      kind: "logs",
      target: "my-task",
      tail: 5,
    });
  });

  it("--tail 5（空格）", () => {
    expect(parseCronArgs("logs my-task --tail 5")).toEqual({
      kind: "logs",
      target: "my-task",
      tail: 5,
    });
  });

  it("非法 tail", () => {
    expect(() => parseCronArgs("logs x --tail=abc")).toThrow();
    expect(() => parseCronArgs("logs x --tail=0")).toThrow();
  });

  it("未知 flag", () => {
    expect(() => parseCronArgs("logs x --bogus")).toThrow();
  });
});
