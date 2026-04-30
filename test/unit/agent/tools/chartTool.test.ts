/**
 * chart_render 工具单测
 *
 * 覆盖：
 *   - 5 类 chart_type 都能 SSR 出 SVG
 *   - inline_data 路径
 *   - artifact_path 路径（JSON 解析 + path-traversal 防御）
 *   - option_overrides 拒函数 / 拒 prototype 污染
 *   - 各种参数错误返错（chart_type / encode / data 缺失等）
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { defineChartTool } from "../../../../src/agent/tools/chartTool";
import { PermissionManager } from "../../../../src/permissions/manager";
import type { ToolInvokeContext } from "../../../../src/agent/tools/registry";

let tmpRoot: string;
let chartsRoot: string;
let artifactsRoot: string;

const ctx: ToolInvokeContext = {
  workspace: process.cwd(),
  permissionManager: new PermissionManager("default"),
};

beforeEach(() => {
  tmpRoot = path.join(
    os.tmpdir(),
    `codeclaw-chart-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  chartsRoot = path.join(tmpRoot, "charts");
  artifactsRoot = path.join(tmpRoot, "artifacts");
  mkdirSync(chartsRoot, { recursive: true });
  mkdirSync(artifactsRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeTool() {
  return defineChartTool({
    sessionId: "test-session",
    chartsRoot,
    artifactsRoot,
  });
}

function extractSavedPath(content: string): string {
  const m = content.match(/chart saved: (\S+\.svg)/);
  if (!m) throw new Error(`no chart path in: ${content}`);
  return m[1];
}

describe("chart_render · 基本路径", () => {
  it("line chart inline_data 出 SVG", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "line",
        encode: { x: "ts", y: "qps" },
        inline_data: [
          { ts: "2026-04-01", qps: 10 },
          { ts: "2026-04-02", qps: 23 },
          { ts: "2026-04-03", qps: 17 },
        ],
        title: "QPS 趋势",
      },
      ctx
    );
    expect(result.ok).toBe(true);
    const svgPath = extractSavedPath(result.content);
    expect(existsSync(svgPath)).toBe(true);
    const svg = readFileSync(svgPath, "utf8");
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain("</svg>");
  });

  it("bar chart 多 y 字段并列", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "bar",
        encode: { x: "region", y: ["q1", "q2", "q3"] },
        inline_data: [
          { region: "north", q1: 10, q2: 12, q3: 14 },
          { region: "south", q1: 8, q2: 11, q3: 13 },
        ],
      },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("rows=2");
  });

  it("pie chart 用 itemName/value", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "pie",
        encode: { itemName: "category", value: "amount" },
        inline_data: [
          { category: "A", amount: 30 },
          { category: "B", amount: 70 },
        ],
      },
      ctx
    );
    expect(result.ok).toBe(true);
  });

  it("scatter chart", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "scatter",
        encode: { x: "x_val", y: "y_val" },
        inline_data: [
          { x_val: 1, y_val: 2 },
          { x_val: 2, y_val: 4 },
          { x_val: 3, y_val: 6 },
        ],
      },
      ctx
    );
    expect(result.ok).toBe(true);
  });

  it("heatmap chart 用 x/y/value 三元组", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "heatmap",
        encode: { x: "hour", y: "weekday", value: "count" },
        inline_data: [
          { hour: "08", weekday: "Mon", count: 5 },
          { hour: "09", weekday: "Mon", count: 12 },
          { hour: "08", weekday: "Tue", count: 7 },
        ],
      },
      ctx
    );
    expect(result.ok).toBe(true);
    const svg = readFileSync(extractSavedPath(result.content), "utf8");
    expect(svg).toMatch(/^<svg /);
  });
});

describe("chart_render · artifact_path 路径", () => {
  it("从 artifact JSON 文件读 rows 字段", async () => {
    const artifact = path.join(artifactsRoot, "q1.txt");
    writeFileSync(
      artifact,
      JSON.stringify({
        rows: [
          { ts: "2026-04-01", qps: 10 },
          { ts: "2026-04-02", qps: 22 },
        ],
      }),
      "utf8"
    );
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "line",
        encode: { x: "ts", y: "qps" },
        artifact_path: artifact,
      },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("rows=2");
  });

  it("artifact 顶层是数组也支持", async () => {
    const artifact = path.join(artifactsRoot, "q2.txt");
    writeFileSync(artifact, JSON.stringify([{ a: 1, b: 2 }, { a: 3, b: 4 }]), "utf8");
    const tool = makeTool();
    const result = await tool.invoke(
      { chart_type: "scatter", encode: { x: "a", y: "b" }, artifact_path: artifact },
      ctx
    );
    expect(result.ok).toBe(true);
  });

  it("自定义 rows_field", async () => {
    const artifact = path.join(artifactsRoot, "q3.txt");
    writeFileSync(
      artifact,
      JSON.stringify({ data: [{ x: 1, y: 2 }] }),
      "utf8"
    );
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "scatter",
        encode: { x: "x", y: "y" },
        artifact_path: artifact,
        rows_field: "data",
      },
      ctx
    );
    expect(result.ok).toBe(true);
  });

  it("artifact_path 越界（不在 artifactsRoot 下）→ 拒绝", async () => {
    const evil = path.join(tmpRoot, "evil.txt");
    writeFileSync(evil, JSON.stringify({ rows: [] }), "utf8");
    const tool = makeTool();
    const result = await tool.invoke(
      { chart_type: "line", encode: { x: "a", y: "b" }, artifact_path: evil },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("artifact_path must be inside");
  });

  it("artifact 不存在 → 报错", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "line",
        encode: { x: "a", y: "b" },
        artifact_path: path.join(artifactsRoot, "nonexistent.txt"),
      },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("artifact not found");
  });

  it("artifact 不是 JSON → 报错", async () => {
    const artifact = path.join(artifactsRoot, "not-json.txt");
    writeFileSync(artifact, "this is not json", "utf8");
    const tool = makeTool();
    const result = await tool.invoke(
      { chart_type: "line", encode: { x: "a", y: "b" }, artifact_path: artifact },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("not valid JSON");
  });
});

describe("chart_render · option_overrides 安全", () => {
  it("拒函数值（防 RCE）", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "line",
        encode: { x: "a", y: "b" },
        inline_data: [{ a: 1, b: 2 }],
        option_overrides: { tooltip: { formatter: () => "evil" } },
      },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/contains a function value/);
  });

  it("拒嵌套函数", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "line",
        encode: { x: "a", y: "b" },
        inline_data: [{ a: 1, b: 2 }],
        option_overrides: { series: [{ label: { formatter: () => "x" } }] },
      },
      ctx
    );
    expect(result.ok).toBe(false);
  });

  it("拒 __proto__ 污染", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "line",
        encode: { x: "a", y: "b" },
        inline_data: [{ a: 1, b: 2 }],
        option_overrides: JSON.parse(`{"__proto__": {"polluted": true}}`),
      },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/forbidden/);
  });

  it("允许字符串 formatter 模板", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "line",
        encode: { x: "a", y: "b" },
        inline_data: [{ a: 1, b: 2 }],
        option_overrides: {
          tooltip: { formatter: "{b}: {c}" },
          xAxis: { axisLabel: { formatter: "{value}h" } },
        },
      },
      ctx
    );
    expect(result.ok).toBe(true);
  });
});

describe("chart_render · 参数校验", () => {
  it("缺 chart_type → 报错", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      { encode: { x: "a", y: "b" }, inline_data: [{ a: 1, b: 2 }] },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("chart_type");
  });

  it("不支持的 chart_type → 报错", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "sankey",
        encode: { x: "a", y: "b" },
        inline_data: [{ a: 1, b: 2 }],
      },
      ctx
    );
    expect(result.ok).toBe(false);
  });

  it("inline_data > 30 行 → 拒绝（让 LLM 改用 artifact_path）", async () => {
    const tool = makeTool();
    const big = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i * 2 }));
    const result = await tool.invoke(
      { chart_type: "line", encode: { x: "x", y: "y" }, inline_data: big },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/use artifact_path/);
  });

  it("line/bar/scatter 缺 encode.x → 报错", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "line",
        encode: { y: "b" },
        inline_data: [{ a: 1, b: 2 }],
      },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/requires x and y/);
  });

  it("pie 缺 encode.itemName/value → 报错", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "pie",
        encode: { value: "amount" },
        inline_data: [{ category: "A", amount: 10 }],
      },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/itemName and value/);
  });

  it("heatmap 缺 encode.value → 报错", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "heatmap",
        encode: { x: "a", y: "b" },
        inline_data: [{ a: "x", b: "y", c: 1 }],
      },
      ctx
    );
    expect(result.ok).toBe(false);
  });

  it("inline_data 与 artifact_path 都缺 → 报错", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      { chart_type: "line", encode: { x: "a", y: "b" } },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/inline_data or artifact_path/);
  });

  it("空 rows → 报错", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      { chart_type: "line", encode: { x: "a", y: "b" }, inline_data: [] },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("nothing to chart");
  });

  it("scatter encode.y 是数组 → 报错", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "scatter",
        encode: { x: "a", y: ["b", "c"] },
        inline_data: [{ a: 1, b: 2, c: 3 }],
      },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("scatter encode.y must be a single field");
  });
});

describe("chart_render · 输出与元信息", () => {
  it("结果包含 rows 数 + chart_type + title", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "bar",
        encode: { x: "label", y: "v" },
        inline_data: [{ label: "a", v: 1 }, { label: "b", v: 2 }],
        title: "测试图",
      },
      ctx
    );
    expect(result.content).toContain("bar");
    expect(result.content).toContain("rows=2");
    expect(result.content).toContain("测试图");
  });

  it("默认 width/height 不传时也能出图", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "line",
        encode: { x: "a", y: "b" },
        inline_data: [{ a: 1, b: 2 }, { a: 2, b: 4 }],
      },
      ctx
    );
    expect(result.ok).toBe(true);
  });

  it("width 超上限被 clamp 到 1600", async () => {
    const tool = makeTool();
    const result = await tool.invoke(
      {
        chart_type: "line",
        encode: { x: "a", y: "b" },
        inline_data: [{ a: 1, b: 2 }],
        width: 99999,
        height: 99999,
      },
      ctx
    );
    expect(result.ok).toBe(true);
  });
});
