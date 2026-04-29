/**
 * Dremio loader 单测 · schema 校验 + 临时目录隔离
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAllDremio, DremioLoaderError } from "./dremio-loader";

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "dremio-loader-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeYaml(dir: string, file: string, content: string): void {
  writeFileSync(path.join(dir, file), content);
}

describe("loadAllDremio", () => {
  it("[1] 加载有效 L1 题", () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeYaml(
        dir,
        "DRM-001.yaml",
        `id: DRM-001
version: 1
layer: L1
prompt: ""
mcp:
  server: dremio
  tool: GetUsefulSystemTableNames
  args: {}
expected:
  must_mention:
    - INFORMATION_SCHEMA
`
      );
      const out = loadAllDremio({ dir });
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe("DRM-001");
      expect(out[0].layer).toBe("L1");
      expect(out[0].mcp?.tool).toBe("GetUsefulSystemTableNames");
    } finally {
      cleanup();
    }
  });

  it("[2] 加载有效 L2 题", () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeYaml(
        dir,
        "DRM-008.yaml",
        `id: DRM-008
version: 1
layer: L2
prompt: |
  有哪些系统表
expected:
  must_mention: [INFORMATION_SCHEMA]
  tool_calls:
    must_invoke:
      - GetUsefulSystemTableNames
`
      );
      const out = loadAllDremio({ dir });
      expect(out).toHaveLength(1);
      expect(out[0].expected.tool_calls?.must_invoke).toEqual(["GetUsefulSystemTableNames"]);
    } finally {
      cleanup();
    }
  });

  it("[3] L1 缺 mcp 字段 → throw", () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeYaml(
        dir,
        "DRM-002.yaml",
        `id: DRM-002
version: 1
layer: L1
prompt: ""
expected:
  must_mention: [x]
`
      );
      expect(() => loadAllDremio({ dir })).toThrow(DremioLoaderError);
    } finally {
      cleanup();
    }
  });

  it("[4] L2 既无 must_mention 也无 must_invoke → throw", () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeYaml(
        dir,
        "DRM-003.yaml",
        `id: DRM-003
version: 1
layer: L2
prompt: hi
expected: {}
`
      );
      expect(() => loadAllDremio({ dir })).toThrow(DremioLoaderError);
    } finally {
      cleanup();
    }
  });

  it("[5] id 格式不符 → throw", () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeYaml(
        dir,
        "DRM-bad.yaml",
        `id: BAD-001
version: 1
layer: L1
prompt: ""
mcp: { server: dremio, tool: x, args: {} }
expected: { must_mention: [a] }
`
      );
      expect(() => loadAllDremio({ dir })).toThrow(/DRM-/);
    } finally {
      cleanup();
    }
  });

  it("[6] 跳过 TEMPLATE 文件", () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeYaml(
        dir,
        "DRM-TEMPLATE.yaml",
        `id: DRM-XXX
version: 1
layer: L1
prompt: ""
mcp: { server: dremio, tool: x, args: {} }
expected: { must_mention: [a] }
`
      );
      writeYaml(
        dir,
        "DRM-001.yaml",
        `id: DRM-001
version: 1
layer: L1
prompt: ""
mcp: { server: dremio, tool: GetUsefulSystemTableNames, args: {} }
expected: { must_mention: [INFORMATION_SCHEMA] }
`
      );
      const out = loadAllDremio({ dir });
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe("DRM-001");
    } finally {
      cleanup();
    }
  });

  it("[7] 跳过 deprecated", () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeYaml(
        dir,
        "DRM-001.yaml",
        `id: DRM-001
version: 1
layer: L1
prompt: ""
deprecated: true
mcp: { server: dremio, tool: x, args: {} }
expected: { must_mention: [a] }
`
      );
      const out = loadAllDremio({ dir });
      expect(out).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("[8] mcp.expectError 透传到结构里", () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeYaml(
        dir,
        "DRM-018.yaml",
        `id: DRM-018
version: 1
layer: E
prompt: ""
mcp:
  server: dremio
  tool: RunSqlQuery
  args: { query: "SELECT not_a_col FROM x" }
  expectError: true
expected:
  must_mention: [error]
`
      );
      const out = loadAllDremio({ dir });
      expect(out[0].mcp?.expectError).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("loadAllDremio · 真实题目集校验", () => {
  it("test/golden/dremio/ 目录下所有 yaml 全部 schema 通过", () => {
    const out = loadAllDremio();
    expect(out.length).toBeGreaterThanOrEqual(20);
    // 确保至少各 layer 都有
    const layers = new Set(out.map((q) => q.layer));
    expect(layers.has("L1")).toBe(true);
    expect(layers.has("L2")).toBe(true);
    expect(layers.has("E")).toBe(true);
  });
});
