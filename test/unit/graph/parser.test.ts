/**
 * graph/parser 单测（M4-#76 step a）
 */

import { describe, expect, it } from "vitest";

import { parseTsFile, isParseTarget } from "../../../src/graph/parser";

describe("isParseTarget", () => {
  it("识别 .ts / .tsx / .js / .jsx", () => {
    expect(isParseTarget("foo.ts")).toBe(true);
    expect(isParseTarget("foo.tsx")).toBe(true);
    expect(isParseTarget("foo.js")).toBe(true);
    expect(isParseTarget("foo.jsx")).toBe(true);
    expect(isParseTarget("foo.mts")).toBe(true);
  });
  it("拒绝 .py / .md / .json", () => {
    expect(isParseTarget("foo.py")).toBe(false);
    expect(isParseTarget("foo.md")).toBe(false);
    expect(isParseTarget("foo.json")).toBe(false);
  });
});

describe("parseTsFile · imports", () => {
  it("named imports", () => {
    const r = parseTsFile(
      "x.ts",
      `import { foo, bar as baz } from './mod';`
    );
    expect(r.imports).toHaveLength(1);
    expect(r.imports[0].module).toBe("./mod");
    expect(r.imports[0].namedBindings).toEqual([
      { imported: "foo", local: "foo" },
      { imported: "bar", local: "baz" },
    ]);
  });

  it("default import", () => {
    const r = parseTsFile("x.ts", `import React from 'react';`);
    expect(r.imports[0].defaultBinding).toBe("React");
    expect(r.imports[0].namedBindings).toEqual([]);
  });

  it("namespace import", () => {
    const r = parseTsFile("x.ts", `import * as ts from 'typescript';`);
    expect(r.imports[0].namespaceBinding).toBe("ts");
  });

  it("混合 default + named", () => {
    const r = parseTsFile("x.ts", `import React, { useState } from 'react';`);
    expect(r.imports[0].defaultBinding).toBe("React");
    expect(r.imports[0].namedBindings).toEqual([{ imported: "useState", local: "useState" }]);
  });
});

describe("parseTsFile · 顶层 symbols", () => {
  it("function declaration", () => {
    const r = parseTsFile("x.ts", `export function foo() {}\nfunction bar() {}`);
    expect(r.symbols).toHaveLength(2);
    expect(r.symbols[0]).toMatchObject({ name: "foo", kind: "function", exported: true });
    expect(r.symbols[1]).toMatchObject({ name: "bar", kind: "function", exported: false });
  });

  it("class declaration", () => {
    const r = parseTsFile("x.ts", `export class Foo {}\nclass Bar {}`);
    const names = r.symbols.map((s) => s.name);
    expect(names).toEqual(["Foo", "Bar"]);
    expect(r.symbols[0].kind).toBe("class");
  });

  it("interface + type alias", () => {
    const r = parseTsFile(
      "x.ts",
      `export interface IFoo {}\ntype TBar = string;`
    );
    expect(r.symbols.find((s) => s.name === "IFoo")?.kind).toBe("interface");
    expect(r.symbols.find((s) => s.name === "TBar")?.kind).toBe("type");
  });

  it("variable / const declaration", () => {
    const r = parseTsFile("x.ts", `export const FOO = 1;\nconst BAR = 2;`);
    expect(r.symbols.find((s) => s.name === "FOO")?.exported).toBe(true);
    expect(r.symbols.find((s) => s.name === "BAR")?.exported).toBe(false);
  });
});

describe("parseTsFile · call sites", () => {
  it("简单 ident call", () => {
    const r = parseTsFile("x.ts", `function f() {} f(); f(1, 2);`);
    expect(r.calls.filter((c) => c.calleeName === "f").length).toBeGreaterThanOrEqual(2);
  });

  it("property access call: obj.foo()", () => {
    const r = parseTsFile("x.ts", `import * as fs from 'fs';\nfs.readFile('x');`);
    const fc = r.calls.find((c) => c.calleeName === "readFile");
    expect(fc).toBeDefined();
    expect(fc?.receiver).toBe("fs");
  });

  it("嵌套 callees 全收集", () => {
    const r = parseTsFile(
      "x.ts",
      `function outer() { inner(); helper(); }\nfunction inner() {}\nfunction helper() {}`
    );
    const calleeNames = r.calls.map((c) => c.calleeName).sort();
    expect(calleeNames).toContain("inner");
    expect(calleeNames).toContain("helper");
  });

  it("行号正确", () => {
    const r = parseTsFile("x.ts", `function f() {}\n\nf();`);
    const call = r.calls.find((c) => c.calleeName === "f");
    expect(call?.line).toBe(3);
  });
});

describe("parseTsFile · 动态 import（P5.3）", () => {
  it("const { X } = await import('path') → named binding", () => {
    const r = parseTsFile(
      "x.ts",
      `async function run() {\n  const { createQueryEngine } = await import("./qe");\n  createQueryEngine({});\n}`
    );
    const imp = r.imports.find((i) => i.module === "./qe");
    expect(imp).toBeDefined();
    expect(imp?.namedBindings).toEqual([
      { imported: "createQueryEngine", local: "createQueryEngine" },
    ]);
  });

  it("const { X as Y } = await import 形式", () => {
    const r = parseTsFile(
      "x.ts",
      `async function r() { const { foo: bar } = await import("./m"); }`
    );
    const imp = r.imports.find((i) => i.module === "./m");
    expect(imp?.namedBindings).toEqual([{ imported: "foo", local: "bar" }]);
  });

  it("const ns = await import('path') → namespace binding", () => {
    const r = parseTsFile(
      "x.ts",
      `async function r() { const m = await import("./m"); m.foo(); }`
    );
    const imp = r.imports.find((i) => i.module === "./m");
    expect(imp?.namespaceBinding).toBe("m");
  });

  it("动态字符串拼接路径不解析（保守跳过）", () => {
    const r = parseTsFile(
      "x.ts",
      'async function r() { const m = await import("./prefix" + suffix); }'
    );
    expect(r.imports.find((i) => i.module.includes("prefix"))).toBeUndefined();
  });
});
