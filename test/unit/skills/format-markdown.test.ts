/**
 * formatMarkdownTable / FALLBACK_CHART_RENDERER 单测 · #84
 */

import { describe, expect, it } from "vitest";
import { formatMarkdownTable, FALLBACK_CHART_RENDERER } from "../../../src/skills/format/markdown";

describe("formatMarkdownTable", () => {
  it("空数组 → '(empty)'", () => {
    expect(formatMarkdownTable([])).toBe("(empty)");
  });

  it("单行 → header + sep + body", () => {
    const out = formatMarkdownTable([{ id: 1, name: "alice" }]);
    expect(out).toBe("| id | name |\n| --- | --- |\n| 1 | alice |");
  });

  it("多行 + null/undefined → 显示空字符串", () => {
    const out = formatMarkdownTable([
      { id: 1, name: "alice", note: null },
      { id: 2, name: "bob", note: undefined },
    ]);
    expect(out).toContain("| 1 | alice |  |");
    expect(out).toContain("| 2 | bob |  |");
  });

  it("cell 含 | / 换行 → 转义防破坏 markdown 语法", () => {
    const out = formatMarkdownTable([{ id: 1, raw: "a|b\nc" }]);
    expect(out).toContain("a\\|b c"); // | escape；\n → 空格
    // 数据行只能有 3 行（header / sep / 1 row）；不应被拆成更多行
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    // 数据行去掉转义后应仅含 3 个 |（开头/中间/结尾）
    const unescaped = lines[2].replace(/\\\|/g, "");
    expect(unescaped.match(/\|/g)?.length).toBe(3);
  });

  it("空 keys 对象 → '(empty)'", () => {
    expect(formatMarkdownTable([{}])).toBe("(empty)");
  });
});

describe("FALLBACK_CHART_RENDERER", () => {
  it("返 text 占位 + 行数信息", async () => {
    const out = await FALLBACK_CHART_RENDERER.render({
      kind: "line",
      rows: [{ x: 1, y: 2 }, { x: 2, y: 3 }],
      title: "demo",
    });
    expect(out.format).toBe("text");
    expect(out.content).toContain("[chart fallback: line · demo]");
    expect(out.content).toContain("2 rows");
    expect(out.rendererName).toBe("fallback-text");
  });

  it("无 title 也能渲染", async () => {
    const out = await FALLBACK_CHART_RENDERER.render({ kind: "bar", rows: [] });
    expect(out.content).toContain("bar");
    expect(out.content).toContain("0 rows");
  });
});
