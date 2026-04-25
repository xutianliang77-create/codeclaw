/**
 * Markdown formatter · #84
 *
 * 给 data_insight skill / user skill 一个无依赖的 markdown table 格式化函数。
 * 复杂图表（折线 / 柱状 / 饼图）走插件式：用户自带 renderer 实现 ChartRenderer 接口。
 */

export interface ChartRendererInput {
  kind: "line" | "bar" | "pie" | "scatter";
  /** 行数据，列名作 key */
  rows: Record<string, unknown>[];
  /** x/y 列名（适用于 line/bar/scatter）；pie 则是 label/value */
  x?: string;
  y?: string | string[];
  title?: string;
}

export interface ChartRendererOutput {
  /** 输出格式：markdown 内嵌 SVG / base64 PNG / 纯文本占位 */
  format: "svg" | "png-base64" | "text";
  content: string;
  /** 渲染器名（用于 /skills 显示） */
  rendererName?: string;
}

export interface ChartRenderer {
  name: string;
  render(input: ChartRendererInput): Promise<ChartRendererOutput> | ChartRendererOutput;
}

/**
 * Markdown table。空 rows → '(empty)'。
 * 列顺序：第一行 keys；非字符串 cell 用 String() 转。
 * 跨字符 cell 含 '|' / '\n' 会被替换防止破坏 markdown 语法。
 */
export function formatMarkdownTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(empty)";
  const cols = Object.keys(rows[0]);
  if (cols.length === 0) return "(empty)";

  const safe = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  };

  const header = `| ${cols.join(" | ")} |`;
  const separator = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((row) => `| ${cols.map((c) => safe(row[c])).join(" | ")} |`)
    .join("\n");
  return [header, separator, body].join("\n");
}

/** 默认 chart renderer：纯文本，输出"chart 不可用"占位（无依赖） */
export const FALLBACK_CHART_RENDERER: ChartRenderer = {
  name: "fallback-text",
  render(input) {
    return {
      format: "text",
      content:
        `[chart fallback: ${input.kind}${input.title ? " · " + input.title : ""}]\n` +
        `(install a chart renderer plugin to visualize; ${input.rows.length} rows omitted)`,
      rendererName: "fallback-text",
    };
  },
};
