/**
 * chart_render · 让 LLM 把 dremio / 任何 tool 拿到的行数据渲染成 ECharts SVG。
 *
 * 设计要点：
 *   - 数据来源三选一（优先级从高到低）：
 *       1. inline_data：≤30 行小数据 LLM 直接传
 *       2. artifact_path：复用 v0.8.1 #3 的 read_artifact 路径；JSON 全文落盘后这里读
 *       3. 都缺 → 报错
 *   - SSR 出 SVG，落盘到 ~/.codeclaw/charts/<sessionId>/<chartId>.svg
 *   - tool result content 只回 path + 元信息（≤200 字节），SVG 不灌进 LLM ctx
 *   - 5 类 chart_type：line / bar / pie / scatter / heatmap；buildOption 模板生成 option
 *   - option_overrides 可选；递归校验拒绝任何函数值（防 RCE）
 *
 * 安全：
 *   - artifact_path 必须落在 ~/.codeclaw/artifacts/ 下（复用 readArtifact 的 path-traversal 防御）
 *   - 输出 SVG 路径限定 ~/.codeclaw/charts/<safeSession>/
 *   - option_overrides 走 deep walk 拒函数 / 拒符号 / 拒 prototype 污染
 *
 * 工作流约定（LLM 看到的 description）：
 *   1. 先调 dremio / sqlite / 别的查询工具拿数据
 *   2. 检查行数 / 列类型 / NULL 比例
 *   3. ≤30 行 inline_data 内传；> 30 行用 artifact_path（dremio 大结果会被 wrapToolResult 自动落盘）
 *   4. 调 chart_render，工具回 SVG path + 摘要；UI 端会自动渲染
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as echarts from "echarts";
import { defaultArtifactsRoot } from "./artifact";
import type {
  ToolDefinition,
  ToolInputSchema,
  ToolInvokeResult,
  ToolRegistry,
} from "./registry";

export const CHART_TOOL_NAME = "chart_render";

const SUPPORTED_CHART_TYPES = ["line", "bar", "pie", "scatter", "heatmap"] as const;
type ChartType = (typeof SUPPORTED_CHART_TYPES)[number];

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 400;
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 1200;
const MAX_ROWS = 5000;
const MAX_INLINE_ROWS = 30;

interface ChartArgs {
  chart_type: ChartType;
  encode: { x?: string; y?: string | string[]; itemName?: string; value?: string };
  inline_data?: Array<Record<string, unknown>>;
  artifact_path?: string;
  /** artifact 文件里 rows 在 JSON 的哪个字段；默认 "rows" */
  rows_field?: string;
  title?: string;
  width?: number;
  height?: number;
  option_overrides?: Record<string, unknown>;
}

export interface ChartToolOptions {
  /** session id 用作输出子目录；默认 "default" */
  sessionId?: string;
  /** charts 根目录覆盖（测试用）。默认 ~/.codeclaw/charts */
  chartsRoot?: string;
  /** artifacts 根目录覆盖（测试用）。默认 ~/.codeclaw/artifacts */
  artifactsRoot?: string;
}

export function defaultChartsRoot(): string {
  return path.join(os.homedir(), ".codeclaw", "charts");
}

const CHART_INPUT_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    chart_type: {
      type: "string",
      enum: [...SUPPORTED_CHART_TYPES],
      description: "图表类型",
    },
    encode: {
      type: "object",
      description:
        "字段映射：line/bar/scatter 用 {x,y}（y 可为字符串数组并列）；" +
        "pie 用 {itemName,value}；heatmap 用 {x,y,value}",
    },
    inline_data: {
      type: "array",
      description: "≤30 行行数据数组；每行是 object（列名→值）",
    },
    artifact_path: {
      type: "string",
      description:
        "复用 read_artifact 路径：dremio 等工具的大结果落盘后的全路径。" +
        "工具会读 JSON、按 rows_field（默认 'rows'）取行数组",
    },
    rows_field: {
      type: "string",
      description: "artifact JSON 中 rows 数组所在字段（默认 'rows'）",
    },
    title: { type: "string" },
    width: { type: "number", description: `默认 ${DEFAULT_WIDTH}，上限 ${MAX_WIDTH}` },
    height: { type: "number", description: `默认 ${DEFAULT_HEIGHT}，上限 ${MAX_HEIGHT}` },
    option_overrides: {
      type: "object",
      description: "覆写 ECharts option 任意字段；不允许函数值",
    },
  },
  required: ["chart_type", "encode"],
};

export function defineChartTool(options: ChartToolOptions = {}): ToolDefinition {
  return {
    name: CHART_TOOL_NAME,
    description: [
      "把行数据渲染成 ECharts SVG 图表，输出落盘到 ~/.codeclaw/charts/。",
      "工作流：先用 dremio_run_sql / 其它查询工具取数 → 验证行数与列类型合理 → 调本工具出图。",
      "数据来源：≤30 行用 inline_data；>30 行用 artifact_path（取 dremio 大结果落盘的 .txt）。",
      "支持 chart_type=line/bar/pie/scatter/heatmap；每种 encode 字段不同。",
      "返回 SVG 文件路径 + 摘要（不返回 SVG 字节，避免灌 ctx）；UI 端会自动渲染。",
    ].join(" "),
    inputSchema: CHART_INPUT_SCHEMA,
    async invoke(args, ctx): Promise<ToolInvokeResult> {
      try {
        const parsed = parseArgs(args);
        const rows = await loadRows(parsed, options);
        const dimensions = inferDimensions(parsed, rows);
        const baseOption = buildOption(parsed, rows, dimensions);
        const finalOption = mergeOverrides(baseOption, parsed.option_overrides);
        const svg = renderSvg(finalOption, parsed.width ?? DEFAULT_WIDTH, parsed.height ?? DEFAULT_HEIGHT);
        const savePath = saveSvg(svg, options);
        const bytes = Buffer.byteLength(svg, "utf8");
        const summary =
          `chart saved: ${savePath} (${bytes} bytes; ${parsed.chart_type}; rows=${rows.length}` +
          `${parsed.title ? `; title="${parsed.title.slice(0, 60)}"` : ""})`;
        return { ok: true, content: summary };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          content: `[chart_render failed] ${msg}`,
          isError: true,
          errorCode: "chart_render_failed",
        };
      } finally {
        // ctx 暂时未用；保留供未来 abortSignal / permission gate
        void ctx;
      }
    },
  };
}

export function registerChartTool(registry: ToolRegistry, options: ChartToolOptions = {}): void {
  registry.register(defineChartTool(options));
}

// ============================================================================
// 内部实现
// ============================================================================

function parseArgs(raw: unknown): ChartArgs {
  if (!raw || typeof raw !== "object") throw new Error("args must be an object");
  const obj = raw as Record<string, unknown>;
  const chart_type = obj.chart_type;
  if (typeof chart_type !== "string" || !(SUPPORTED_CHART_TYPES as readonly string[]).includes(chart_type)) {
    throw new Error(`chart_type must be one of: ${SUPPORTED_CHART_TYPES.join(", ")}`);
  }
  if (!obj.encode || typeof obj.encode !== "object" || Array.isArray(obj.encode)) {
    throw new Error("encode must be an object");
  }
  const encode = obj.encode as ChartArgs["encode"];

  if (obj.inline_data !== undefined && !Array.isArray(obj.inline_data)) {
    throw new Error("inline_data must be an array of row objects");
  }
  if (obj.inline_data && (obj.inline_data as unknown[]).length > MAX_INLINE_ROWS) {
    throw new Error(
      `inline_data > ${MAX_INLINE_ROWS} rows; use artifact_path for larger datasets`
    );
  }
  if (obj.artifact_path !== undefined && typeof obj.artifact_path !== "string") {
    throw new Error("artifact_path must be a string");
  }
  if (!obj.inline_data && !obj.artifact_path) {
    throw new Error("either inline_data or artifact_path is required");
  }
  const width = clampNumber(obj.width, DEFAULT_WIDTH, 100, MAX_WIDTH, "width");
  const height = clampNumber(obj.height, DEFAULT_HEIGHT, 100, MAX_HEIGHT, "height");

  if (obj.option_overrides !== undefined) {
    if (!isPlainObject(obj.option_overrides)) {
      throw new Error("option_overrides must be a plain object");
    }
    rejectFunctions(obj.option_overrides, "option_overrides");
  }

  return {
    chart_type: chart_type as ChartType,
    encode,
    ...(obj.inline_data ? { inline_data: obj.inline_data as Array<Record<string, unknown>> } : {}),
    ...(obj.artifact_path ? { artifact_path: obj.artifact_path as string } : {}),
    ...(obj.rows_field ? { rows_field: obj.rows_field as string } : {}),
    ...(typeof obj.title === "string" ? { title: obj.title } : {}),
    width,
    height,
    ...(obj.option_overrides ? { option_overrides: obj.option_overrides as Record<string, unknown> } : {}),
  };
}

function clampNumber(
  v: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 递归扫 option_overrides，拒函数 / 拒 symbol。防 LLM 写 `formatter: () => fetch('evil.com')`。
 * 字符串 / 数字 / 布尔 / null / 数组 / 普通对象都允许。
 * Prototype 污染防御：禁 __proto__ / constructor / prototype 当 key。
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function rejectFunctions(value: unknown, path: string): void {
  if (value === null || value === undefined) return;
  const t = typeof value;
  if (t === "function") {
    throw new Error(`${path} contains a function value (forbidden for security)`);
  }
  if (t === "symbol") {
    throw new Error(`${path} contains a symbol value (forbidden)`);
  }
  if (t !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      rejectFunctions(value[i], `${path}[${i}]`);
    }
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k)) {
      throw new Error(`${path}.${k} is forbidden (prototype pollution)`);
    }
    rejectFunctions(v, `${path}.${k}`);
  }
}

async function loadRows(
  args: ChartArgs,
  opts: ChartToolOptions
): Promise<Array<Record<string, unknown>>> {
  if (args.inline_data) {
    return args.inline_data;
  }
  if (!args.artifact_path) throw new Error("no data source provided");
  const root = path.resolve(opts.artifactsRoot ?? defaultArtifactsRoot());
  const target = path.resolve(args.artifact_path);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`artifact_path must be inside ${root}`);
  }
  if (!existsSync(target)) {
    throw new Error(`artifact not found: ${target}`);
  }
  const raw = readFileSync(target, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `artifact ${target} is not valid JSON; chart_render only reads JSON artifacts`
    );
  }
  const field = args.rows_field ?? "rows";
  const rows = extractRows(parsed, field);
  if (rows.length > MAX_ROWS) {
    throw new Error(`rows > ${MAX_ROWS}; aggregate before charting`);
  }
  return rows;
}

function extractRows(parsed: unknown, field: string): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) {
    if (parsed.every(isPlainObject)) return parsed as Array<Record<string, unknown>>;
    throw new Error("artifact JSON top-level array must contain row objects");
  }
  if (isPlainObject(parsed)) {
    const rows = parsed[field];
    if (!Array.isArray(rows)) {
      throw new Error(`artifact JSON has no array at field '${field}'`);
    }
    if (!rows.every(isPlainObject)) {
      throw new Error(`artifact field '${field}' must be an array of row objects`);
    }
    return rows as Array<Record<string, unknown>>;
  }
  throw new Error("artifact JSON must be array of rows or object containing rows");
}

interface Dimensions {
  list: Array<{ name: string }>;
}

function inferDimensions(args: ChartArgs, rows: Array<Record<string, unknown>>): Dimensions {
  if (rows.length === 0) {
    throw new Error("rows is empty; nothing to chart");
  }
  // 用首行键名作为 dataset 维度顺序
  const keys = Object.keys(rows[0]);
  if (keys.length === 0) throw new Error("rows[0] has no fields");
  return { list: keys.map((name) => ({ name })) };
}

/**
 * 5 个 chart_type 的 option 模板。让 LLM 只填 chart_type + encode，剩下结构由后端定。
 */
export function buildOption(
  args: ChartArgs,
  rows: Array<Record<string, unknown>>,
  dimensions: Dimensions
): Record<string, unknown> {
  const keys = dimensions.list.map((d) => d.name);
  const dataset = {
    source: rows,
    dimensions: keys,
  };
  const base: Record<string, unknown> = {
    title: args.title ? { text: args.title, left: "center" } : undefined,
    tooltip: { trigger: pickTrigger(args.chart_type) },
    legend: { top: args.title ? 30 : 8 },
    dataset,
    animation: false, // SSR 一帧出图，关动画
  };

  switch (args.chart_type) {
    case "line":
    case "bar": {
      const { x, y } = ensureXY(args.encode, args.chart_type);
      const ys = Array.isArray(y) ? y : [y];
      base.xAxis = { type: inferAxisType(rows, x) };
      base.yAxis = { type: "value" };
      base.series = ys.map((field) => ({
        type: args.chart_type,
        name: field,
        encode: { x, y: field },
      }));
      base.grid = { left: 50, right: 24, top: args.title ? 60 : 40, bottom: 40 };
      break;
    }
    case "scatter": {
      const { x, y } = ensureXY(args.encode, args.chart_type);
      if (Array.isArray(y)) throw new Error("scatter encode.y must be a single field");
      base.xAxis = { type: inferAxisType(rows, x) };
      base.yAxis = { type: "value" };
      base.series = [{ type: "scatter", encode: { x, y }, symbolSize: 8 }];
      base.grid = { left: 50, right: 24, top: args.title ? 60 : 40, bottom: 40 };
      break;
    }
    case "pie": {
      const { itemName, value } = args.encode;
      if (!itemName || !value) {
        throw new Error("pie encode requires itemName and value");
      }
      base.series = [
        {
          type: "pie",
          radius: ["35%", "65%"],
          encode: { itemName, value },
          label: { formatter: "{b}: {c} ({d}%)" },
        },
      ];
      delete base.legend;
      break;
    }
    case "heatmap": {
      const { x, y, value } = args.encode as { x?: string; y?: string; value?: string };
      if (!x || !y || !value) {
        throw new Error("heatmap encode requires x, y and value");
      }
      const xCats = uniqueValues(rows, x).map(String);
      const yCats = uniqueValues(rows, y).map(String);
      const valueArray = rows.map((r) => Number(r[value])).filter((n) => Number.isFinite(n));
      const minV = valueArray.length ? Math.min(...valueArray) : 0;
      const maxV = valueArray.length ? Math.max(...valueArray) : 1;
      base.xAxis = { type: "category", data: xCats };
      base.yAxis = { type: "category", data: yCats };
      base.visualMap = {
        min: minV,
        max: maxV,
        calculable: true,
        orient: "horizontal",
        left: "center",
        bottom: 8,
      };
      base.series = [
        {
          type: "heatmap",
          // heatmap 用三元组数组而非 dataset.encode（ECharts heatmap 习惯）
          data: rows.map((r) => [String(r[x]), String(r[y]), Number(r[value])]),
          label: { show: false },
        },
      ];
      delete base.dataset;
      base.grid = { left: 80, right: 24, top: args.title ? 60 : 40, bottom: 70 };
      break;
    }
  }

  // 清掉 undefined 值，echarts 不喜欢
  for (const k of Object.keys(base)) {
    if (base[k] === undefined) delete base[k];
  }
  return base;
}

function ensureXY(
  encode: ChartArgs["encode"],
  chartType: string
): { x: string; y: string | string[] } {
  if (!encode.x || !encode.y) {
    throw new Error(`${chartType} encode requires x and y`);
  }
  return { x: encode.x, y: encode.y };
}

function pickTrigger(t: ChartType): string {
  if (t === "pie" || t === "scatter") return "item";
  return "axis";
}

function inferAxisType(rows: Array<Record<string, unknown>>, field: string): string {
  if (rows.length === 0) return "category";
  const sample = rows[0][field];
  if (sample instanceof Date) return "time";
  if (typeof sample === "string" && /^\d{4}-\d{2}-\d{2}/.test(sample)) return "time";
  if (typeof sample === "number") return "value";
  return "category";
}

function uniqueValues(rows: Array<Record<string, unknown>>, field: string): unknown[] {
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  for (const r of rows) {
    const v = r[field];
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * 浅合并 overrides 进 base option。冲突字段以 overrides 为准。
 * 数组直接覆盖（不深合并），对象浅合并。
 */
function mergeOverrides(
  base: Record<string, unknown>,
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  if (!overrides) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (
      isPlainObject(v) &&
      isPlainObject(out[k])
    ) {
      out[k] = { ...(out[k] as Record<string, unknown>), ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function renderSvg(option: Record<string, unknown>, width: number, height: number): string {
  // echarts.init 在 Node SSR 模式下第一参数传 null
  const inst = echarts.init(null as never, undefined, {
    renderer: "svg",
    ssr: true,
    width,
    height,
  });
  inst.setOption(option as never);
  const svg = inst.renderToSVGString();
  inst.dispose();
  return svg;
}

function saveSvg(svg: string, opts: ChartToolOptions): string {
  const root = opts.chartsRoot ?? defaultChartsRoot();
  const safeSession = (opts.sessionId ?? "default").replace(/[^a-zA-Z0-9_-]/g, "_") || "anon";
  const dir = path.join(root, safeSession);
  mkdirSync(dir, { recursive: true });
  const id = `chart_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(dir, `${id}.svg`);
  writeFileSync(file, svg, "utf8");
  return file;
}
