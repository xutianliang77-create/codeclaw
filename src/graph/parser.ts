/**
 * TS Compiler API parser（M4-#76 step a+b）
 *
 * 单文件 → 提取：
 *   - imports：`import { X, Y as Z } from './mod'` / `import * as N from 'pkg'` / 默认导入
 *   - 顶层符号：function / class / const / interface / type 声明
 *   - call sites：所有 CallExpression 的 callee.name + 行号
 *
 * 设计取舍：
 *   - 走 ts.createSourceFile（轻量），不构 Program / TypeChecker —— 跨文件类型解析极贵，
 *     本步只做"语法"级 graph，名字未解析时 calleePath 留 NULL，让查询时 fallback by-name
 *   - 不解析 require() / dynamic import；ESM only
 *   - import path 解析在 builder.ts 做（要 workspace fs context）
 */

import * as ts from "typescript";

export interface ParsedImport {
  module: string; // import 的目标 module 字符串（'./foo' / 'react' 等）
  defaultBinding?: string;
  namespaceBinding?: string;
  namedBindings: Array<{ imported: string; local: string }>;
}

export interface ParsedSymbol {
  name: string;
  kind: "function" | "class" | "const" | "export" | "interface" | "type";
  line: number;
  exported: boolean;
}

export interface ParsedCall {
  calleeName: string; // 'foo' from `foo()`；`obj.foo()` 时只取 'foo'
  receiver?: string; // 'obj' from `obj.foo()`
  line: number;
}

export interface ParseResult {
  imports: ParsedImport[];
  symbols: ParsedSymbol[];
  calls: ParsedCall[];
}

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);

export function isParseTarget(filename: string): boolean {
  for (const ext of TS_EXTENSIONS) {
    if (filename.endsWith(ext)) return true;
  }
  return false;
}

export function parseTsFile(filename: string, content: string): ParseResult {
  const sourceFile = ts.createSourceFile(
    filename,
    content,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    detectScriptKind(filename)
  );

  const imports: ParsedImport[] = [];
  const symbols: ParsedSymbol[] = [];
  const calls: ParsedCall[] = [];

  const lineOf = (pos: number): number => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node, isTopLevel: boolean): void => {
    if (isTopLevel && ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteral(specifier)) {
        imports.push(parseImportClause(node.importClause, specifier.text));
      }
    }

    // P5.3：识别 `const { X } = await import("path")` / `const X = await import("path")`
    //  形式（任意层级，不限 top-level）。返回与静态 import 相同的 ParsedImport 结构，
    //  让 builder.importBindings 正确解析。
    if (ts.isVariableDeclaration(node)) {
      const dyn = parseDynamicImportDeclaration(node);
      if (dyn) imports.push(dyn);
    }

    if (isTopLevel) {
      const sym = parseTopLevelSymbol(node, lineOf);
      if (sym) symbols.push(sym);
    }

    if (ts.isCallExpression(node)) {
      const c = parseCallExpression(node, lineOf);
      if (c) calls.push(c);
    }

    ts.forEachChild(node, (child) => visit(child, false));
  };

  ts.forEachChild(sourceFile, (n) => visit(n, true));

  return { imports, symbols, calls };
}

function detectScriptKind(filename: string): ts.ScriptKind {
  if (filename.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filename.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filename.endsWith(".ts") || filename.endsWith(".mts") || filename.endsWith(".cts"))
    return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function parseImportClause(clause: ts.ImportClause | undefined, module: string): ParsedImport {
  const out: ParsedImport = { module, namedBindings: [] };
  if (!clause) return out;
  if (clause.name) out.defaultBinding = clause.name.text;
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      out.namespaceBinding = clause.namedBindings.name.text;
    } else if (ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        out.namedBindings.push({
          imported: (el.propertyName ?? el.name).text,
          local: el.name.text,
        });
      }
    }
  }
  return out;
}

function parseTopLevelSymbol(
  node: ts.Node,
  lineOf: (pos: number) => number
): ParsedSymbol | null {
  const exported = hasExportModifier(node);

  if (ts.isFunctionDeclaration(node) && node.name) {
    return { name: node.name.text, kind: "function", line: lineOf(node.getStart()), exported };
  }
  if (ts.isClassDeclaration(node) && node.name) {
    return { name: node.name.text, kind: "class", line: lineOf(node.getStart()), exported };
  }
  if (ts.isInterfaceDeclaration(node)) {
    return { name: node.name.text, kind: "interface", line: lineOf(node.getStart()), exported };
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return { name: node.name.text, kind: "type", line: lineOf(node.getStart()), exported };
  }
  if (ts.isVariableStatement(node)) {
    const exp = exported;
    for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        return {
          name: decl.name.text,
          kind: "const",
          line: lineOf(decl.getStart()),
          exported: exp,
        };
      }
    }
  }
  if (ts.isExportAssignment(node)) {
    return { name: "default", kind: "export", line: lineOf(node.getStart()), exported: true };
  }
  return null;
}

/**
 * P5.3：解析 `const { X } = await import("path")` / `const X = await import("path")`
 *
 * 返回与静态 ImportDeclaration 等价的 ParsedImport（含 named / namespace 绑定），
 * 让下游 builder.importBindings 正确路由 calleePath。
 *
 * 仅支持纯字符串路径（动态拼接路径不解析）。
 */
function parseDynamicImportDeclaration(decl: ts.VariableDeclaration): ParsedImport | null {
  const init = decl.initializer;
  if (!init) return null;

  // 剥 await 包装：await import(...) 或 import(...)
  const callExpr = ts.isAwaitExpression(init) ? init.expression : init;
  if (!ts.isCallExpression(callExpr)) return null;
  if (callExpr.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;

  const arg = callExpr.arguments[0];
  if (!arg || !ts.isStringLiteral(arg)) return null;
  const module = arg.text;

  const out: ParsedImport = { module, namedBindings: [] };

  if (ts.isObjectBindingPattern(decl.name)) {
    // const { X, Y as Z } = await import("path")
    for (const el of decl.name.elements) {
      if (!ts.isIdentifier(el.name)) continue;
      const local = el.name.text;
      const imported =
        el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : local;
      out.namedBindings.push({ imported, local });
    }
  } else if (ts.isIdentifier(decl.name)) {
    // const ns = await import("path") → 当 namespace 处理（ns.X 形式调用归到该 module）
    out.namespaceBinding = decl.name.text;
  } else {
    return null; // 嵌套 binding pattern 等不支持
  }

  return out;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) return false;
  return modifiers.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword
  );
}

function parseCallExpression(
  node: ts.CallExpression,
  lineOf: (pos: number) => number
): ParsedCall | null {
  const expr = node.expression;
  if (ts.isIdentifier(expr)) {
    return { calleeName: expr.text, line: lineOf(node.getStart()) };
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const receiver = ts.isIdentifier(expr.expression) ? expr.expression.text : undefined;
    return {
      calleeName: expr.name.text,
      ...(receiver ? { receiver } : {}),
      line: lineOf(node.getStart()),
    };
  }
  return null;
}
