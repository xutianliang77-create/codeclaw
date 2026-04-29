/**
 * Dremio Golden Suite · YAML 加载器
 *
 * 扫描 test/golden/dremio/*.yaml → DremioQuestion[]
 *  - id 形如 DRM-001
 *  - layer = L1 | L2 | E
 *  - L1 必须含 mcp.{server,tool}；L2/E 必须含 prompt（已由 schema 保证）
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { DremioDirectCall, DremioLayer, DremioQuestion, DremioToolCallSpec } from "./dremio-types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DREMIO_DIR = path.resolve(__dirname, "..", "dremio");

const ALLOWED_LAYERS: DremioLayer[] = ["L1", "L2", "E"];

export class DremioLoaderError extends Error {}

export function loadAllDremio(options: { skipDeprecated?: boolean; dir?: string } = {}): DremioQuestion[] {
  const { skipDeprecated = true, dir = DREMIO_DIR } = options;
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter(
      (f) =>
        /^DRM-.+\.ya?ml$/i.test(f) &&
        !f.startsWith(".") &&
        !/^DRM-(TEMPLATE|EXAMPLE)\b/i.test(f)
    )
    .sort();

  const out: DremioQuestion[] = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const raw = readFileSync(full, "utf8");
    const parsed = yaml.load(raw) as unknown;
    const q = validate(parsed, file);
    if (skipDeprecated && q.deprecated) continue;
    out.push(q);
  }
  return out;
}

export function dremioDir(): string {
  return DREMIO_DIR;
}

function validate(input: unknown, file: string): DremioQuestion {
  if (!input || typeof input !== "object") {
    throw new DremioLoaderError(`${file}: root must be an object`);
  }
  const obj = input as Record<string, unknown>;

  const id = requireString(obj, "id", file);
  if (!/^DRM-\d{3,}$/i.test(id)) {
    throw new DremioLoaderError(`${file}: id must match /^DRM-\\d{3,}$/ (got "${id}")`);
  }
  const version = requireNumber(obj, "version", file);
  const layer = requireString(obj, "layer", file) as DremioLayer;
  if (!ALLOWED_LAYERS.includes(layer)) {
    throw new DremioLoaderError(`${file}: invalid layer "${layer}" (must be L1|L2|E)`);
  }

  // mcp 字段：L1 必填；L2/E 可选
  let mcp: DremioDirectCall | undefined;
  if (obj.mcp !== undefined) {
    mcp = parseMcpDirectCall(obj.mcp, file);
  }
  if (layer === "L1" && !mcp) {
    throw new DremioLoaderError(`${file}: layer L1 requires 'mcp' field with server+tool`);
  }

  // prompt: L1 或带 mcp 字段的 E 题允许空字符串（直接调 MCP 不需要 prompt）；L2/不带 mcp 的 E 必须非空
  let prompt: string;
  if (layer === "L1" || mcp) {
    prompt = typeof obj.prompt === "string" ? obj.prompt : "";
  } else {
    prompt = requireString(obj, "prompt", file);
  }

  const expected = obj.expected as Record<string, unknown> | undefined;
  if (!expected || typeof expected !== "object") {
    throw new DremioLoaderError(`${file}: expected is required`);
  }
  const mustMention = optionalStringArray(expected, "must_mention");
  const mustNotMention = optionalStringArray(expected, "must_not_mention");
  const toolCalls = parseToolCallsSpec(expected.tool_calls, file);

  // L2 题至少需要 must_mention 或 tool_calls.must_invoke 之一
  if (layer === "L2" && mustMention.length === 0 && (!toolCalls?.must_invoke || toolCalls.must_invoke.length === 0)) {
    throw new DremioLoaderError(
      `${file}: layer L2 must have either expected.must_mention or expected.tool_calls.must_invoke`
    );
  }

  return {
    id,
    version,
    layer,
    description: typeof obj.description === "string" ? obj.description : undefined,
    prompt,
    mcp,
    expected: {
      must_mention: mustMention.length > 0 ? mustMention : undefined,
      must_not_mention: mustNotMention.length > 0 ? mustNotMention : undefined,
      tool_calls: toolCalls,
      rubric: typeof expected.rubric === "string" ? expected.rubric : undefined,
    },
    deprecated: obj.deprecated === true,
  };
}

function parseMcpDirectCall(input: unknown, file: string): DremioDirectCall {
  if (!input || typeof input !== "object") {
    throw new DremioLoaderError(`${file}: mcp must be object`);
  }
  const obj = input as Record<string, unknown>;
  const server = typeof obj.server === "string" && obj.server ? obj.server : "dremio";
  const tool = requireString(obj, "tool", `${file}.mcp`);
  let args: Record<string, unknown> = {};
  if (obj.args !== undefined) {
    if (!obj.args || typeof obj.args !== "object" || Array.isArray(obj.args)) {
      throw new DremioLoaderError(`${file}: mcp.args must be object`);
    }
    args = obj.args as Record<string, unknown>;
  }
  return {
    server,
    tool,
    args,
    ...(obj.expectError === true ? { expectError: true } : {}),
    ...(typeof obj.timeoutMs === "number" ? { timeoutMs: obj.timeoutMs } : {}),
  };
}

function parseToolCallsSpec(input: unknown, file: string): DremioToolCallSpec | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new DremioLoaderError(`${file}: expected.tool_calls must be object`);
  }
  const obj = input as Record<string, unknown>;
  const mustInvoke = optionalStringArray(obj, "must_invoke");
  const mustNotInvoke = optionalStringArray(obj, "must_not_invoke");
  if (mustInvoke.length === 0 && mustNotInvoke.length === 0) return undefined;
  return {
    ...(mustInvoke.length > 0 ? { must_invoke: mustInvoke } : {}),
    ...(mustNotInvoke.length > 0 ? { must_not_invoke: mustNotInvoke } : {}),
  };
}

function requireString(obj: Record<string, unknown>, key: string, file: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new DremioLoaderError(`${file}: field "${key}" required (string)`);
  }
  return v;
}

function requireNumber(obj: Record<string, unknown>, key: string, file: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new DremioLoaderError(`${file}: field "${key}" required (number)`);
  }
  return v;
}

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (v == null) return [];
  if (!Array.isArray(v)) throw new DremioLoaderError(`field "${key}" must be array if present`);
  return v.filter((e) => typeof e === "string") as string[];
}
