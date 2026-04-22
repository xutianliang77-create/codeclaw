import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { OrchestrationApprovalRequest } from "./types";

interface ApprovedExecutionPlan {
  toolName: "write" | "replace";
  prompt: string;
}

interface AnchorBlock {
  startLine: number;
  endLine: number;
  text: string;
  kind: "function" | "class" | "other";
  name: string | null;
  isExported: boolean;
  isDefaultExport: boolean;
}

interface FunctionPatchPlan {
  startLine: number;
  endLine: number;
  insertedLines: string[];
}

interface LineEditPlan {
  startLine: number;
  deleteCount: number;
  insertedLines: string[];
}

const COMMENT_PREFIX_BY_EXTENSION = new Map<string, string>([
  [".ts", "//"],
  [".tsx", "//"],
  [".js", "//"],
  [".jsx", "//"],
  [".mjs", "//"],
  [".cjs", "//"],
  [".java", "//"],
  [".kt", "//"],
  [".kts", "//"],
  [".swift", "//"],
  [".cs", "//"],
  [".go", "//"],
  [".rs", "//"],
  [".c", "//"],
  [".cc", "//"],
  [".cpp", "//"],
  [".cxx", "//"],
  [".h", "//"],
  [".hpp", "//"],
  [".php", "//"],
  [".py", "#"],
  [".rb", "#"],
  [".sh", "#"],
  [".yaml", "#"],
  [".yml", "#"],
  [".toml", "#"],
  [".md", "<!--"],
  [".txt", ""]
]);

function normalizeStem(value: string): string {
  return value.replace(/\.[^.]+$/, "");
}

function toWords(value: string): string[] {
  return normalizeStem(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function toCamelCase(value: string): string {
  const words = toWords(value);
  if (words.length === 0) {
    return "generatedItem";
  }

  return words
    .map((word, index) => {
      const normalized = word.toLowerCase();
      if (index === 0) {
        return normalized;
      }

      return `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
    })
    .join("");
}

function toPascalCase(value: string): string {
  const words = toWords(value);
  if (words.length === 0) {
    return "GeneratedItem";
  }

  return words
    .map((word) => {
      const normalized = word.toLowerCase();
      return `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
    })
    .join("");
}

function toSnakeCase(value: string): string {
  const words = toWords(value);
  return words.length > 0 ? words.map((word) => word.toLowerCase()).join("_") : "generated_item";
}

function resolveWorkspacePath(workspace: string, target: string): string {
  const absolutePath = path.isAbsolute(target) ? path.resolve(target) : path.resolve(workspace, target);
  const normalizedWorkspace = path.resolve(workspace);

  if (absolutePath !== normalizedWorkspace && !absolutePath.startsWith(`${normalizedWorkspace}${path.sep}`)) {
    throw new Error(`path is outside workspace: ${absolutePath}`);
  }

  return absolutePath;
}

function buildPlaceholderLines(target: string, planGoal: string): string[] {
  const extension = path.extname(target).toLowerCase();
  const prefix = COMMENT_PREFIX_BY_EXTENSION.get(extension);

  if (prefix === undefined) {
    throw new Error(`no deterministic placeholder template for ${extension || "[no extension]"}`);
  }

  if (prefix === "<!--") {
    return [
      `<!-- Orchestration placeholder created for: ${planGoal} -->`,
      `<!-- Approved target: ${target} -->`,
      `<!-- Next step: replace this placeholder with the real implementation. -->`
    ];
  }

  if (prefix === "") {
    return [
      `Orchestration placeholder created for: ${planGoal}`,
      `Approved target: ${target}`,
      `Next step: replace this placeholder with the real implementation.`
    ];
  }

  return [
    `${prefix} Orchestration placeholder created for: ${planGoal}`,
    `${prefix} Approved target: ${target}`,
    `${prefix} Next step: replace this placeholder with the real implementation.`
  ];
}

function buildTypeScriptWriteScaffold(target: string, planGoal: string): string {
  const stem = path.basename(target, path.extname(target));
  const functionName = toCamelCase(stem);

  return [
    `// Generated scaffold for approved orchestration goal: ${planGoal}`,
    `export interface ${toPascalCase(stem)}Input {`,
    "  value?: string;",
    "}",
    "",
    `export function ${functionName}(input: ${toPascalCase(stem)}Input = {}): string {`,
    `  return input.value ?? "${functionName}";`,
    "}"
  ].join("\n");
}

function buildReactWriteScaffold(target: string, planGoal: string): string {
  const stem = path.basename(target, path.extname(target));
  const componentName = toPascalCase(stem);

  return [
    `// Generated scaffold for approved orchestration goal: ${planGoal}`,
    `export interface ${componentName}Props {`,
    "  title?: string;",
    "}",
    "",
    `export function ${componentName}({ title = "${componentName}" }: ${componentName}Props) {`,
    "  return (",
    "    <section>",
    "      <h1>{title}</h1>",
    "    </section>",
    "  );",
    "}"
  ].join("\n");
}

function buildPythonWriteScaffold(target: string, planGoal: string): string {
  const stem = path.basename(target, path.extname(target));
  const functionName = toSnakeCase(stem);

  return [
    `# Generated scaffold for approved orchestration goal: ${planGoal}`,
    `def ${functionName}(value: str = "${functionName}") -> str:`,
    '    """Return a deterministic scaffold value."""',
    "    return value"
  ].join("\n");
}

function buildMarkdownWriteScaffold(target: string, planGoal: string): string {
  const stem = path.basename(target, path.extname(target));
  const title = toWords(stem).map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`).join(" ") || stem;

  return [
    `# ${title}`,
    "",
    `Generated scaffold for approved orchestration goal: ${planGoal}`,
    "",
    "## Next Steps",
    "",
    "- Replace this scaffold with the final content.",
    `- Confirm target path: ${target}.`
  ].join("\n");
}

function buildGenericWriteScaffold(target: string, planGoal: string): string {
  return `${buildPlaceholderLines(target, planGoal).join("\n")}\n`;
}

function buildWriteScaffold(target: string, planGoal: string): string {
  const extension = path.extname(target).toLowerCase();

  if (extension === ".ts" || extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return `${buildTypeScriptWriteScaffold(target, planGoal)}\n`;
  }

  if (extension === ".tsx" || extension === ".jsx") {
    return `${buildReactWriteScaffold(target, planGoal)}\n`;
  }

  if (extension === ".py") {
    return `${buildPythonWriteScaffold(target, planGoal)}\n`;
  }

  if (extension === ".md") {
    return `${buildMarkdownWriteScaffold(target, planGoal)}\n`;
  }

  return buildGenericWriteScaffold(target, planGoal);
}

function buildPatchSnippet(target: string, planGoal: string): string {
  const extension = path.extname(target).toLowerCase();
  const stem = path.basename(target, path.extname(target));

  if (extension === ".ts" || extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    const patchName = `apply${toPascalCase(stem)}ApprovedPatch`;
    return [
      `export function ${patchName}(): string {`,
      `  return "${toCamelCase(stem)}-approved";`,
      "}"
    ].join("\n");
  }

  if (extension === ".tsx" || extension === ".jsx") {
    const patchName = `Approved${toPascalCase(stem)}Patch`;
    return [
      `export function ${patchName}() {`,
      "  return <aside>Approved orchestration patch</aside>;",
      "}"
    ].join("\n");
  }

  if (extension === ".py") {
    const patchName = `apply_${toSnakeCase(stem)}_approved_patch`;
    return [
      `def ${patchName}() -> str:`,
      '    return "approved-patch"'
    ].join("\n");
  }

  const prefix = COMMENT_PREFIX_BY_EXTENSION.get(extension) ?? "//";
  if (prefix === "<!--") {
    return `<!-- Approved orchestration patch for: ${planGoal} -->`;
  }

  if (prefix === "") {
    return `Approved orchestration patch for: ${planGoal}`;
  }

  return `${prefix} Approved orchestration patch for: ${planGoal}`;
}

function buildFunctionPatchSnippet(target: string, anchorName: string | null): string[] {
  const extension = path.extname(target).toLowerCase();
  const normalizedName =
    anchorName && anchorName.trim().length > 0
      ? anchorName
      : path.basename(target, path.extname(target));

  if (extension === ".ts" || extension === ".tsx" || extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs") {
    const markerName = `${toCamelCase(normalizedName)}ApprovedPatchMarker`;
    return [
      `const ${markerName} = "${toCamelCase(normalizedName)}-approved";`,
      `void ${markerName};`
    ];
  }

  if (extension === ".py") {
    const markerName = `${toSnakeCase(normalizedName)}_approved_patch_marker`;
    return [
      `${markerName} = "${toSnakeCase(normalizedName)}_approved"`,
      `_ = ${markerName}`
    ];
  }

  return [];
}

function countBraces(line: string): number {
  return [...line].reduce((depth, char) => {
    if (char === "{") {
      return depth + 1;
    }

    if (char === "}") {
      return depth - 1;
    }

    return depth;
  }, 0);
}

function inferAnchorKind(line: string): AnchorBlock["kind"] {
  if (/\b(function|def)\b/.test(line)) {
    return "function";
  }

  if (/\bclass\b/.test(line)) {
    return "class";
  }

  return "other";
}

function inferAnchorName(line: string): string | null {
  const trimmed = line.trim();
  const patterns = [
    /(?:export\s+default\s+|export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
    /def\s+([A-Za-z0-9_]+)/,
    /(?:export\s+)?class\s+([A-Za-z0-9_$]+)/,
    /(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/,
    /(?:export\s+)?type\s+([A-Za-z0-9_$]+)/,
    /(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=/,
    /(?:export\s+)?let\s+([A-Za-z0-9_$]+)\s*=/,
    /(?:export\s+)?var\s+([A-Za-z0-9_$]+)\s*=/
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function inferAnchorExportFlags(line: string): { isExported: boolean; isDefaultExport: boolean } {
  const trimmed = line.trim();
  return {
    isExported: /^export\b/.test(trimmed),
    isDefaultExport: /^export\s+default\b/.test(trimmed)
  };
}

function extractPreferredSymbols(planGoal: string, target: string): Set<string> {
  const words = (planGoal.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [])
    .filter((word) => word.length >= 3)
    .map((word) => word.toLowerCase());
  const stem = path.basename(target, path.extname(target));
  const derived = [toCamelCase(stem), toPascalCase(stem), toSnakeCase(stem)].map((item) => item.toLowerCase());

  return new Set([...words, ...derived]);
}

function countLeadingWhitespace(line: string): number {
  const match = line.match(/^\s*/);
  return match?.[0]?.length ?? 0;
}

function buildIndentedLines(lines: string[], indentation: string): string[] {
  return lines.map((line) => (line ? `${indentation}${line}` : ""));
}

function matchesPreferredSymbol(anchorName: string, preferredSymbols: Set<string>): boolean {
  const normalizedAnchorName = anchorName.toLowerCase();

  for (const symbol of preferredSymbols) {
    if (symbol.length < 3) {
      continue;
    }

    if (normalizedAnchorName === symbol || normalizedAnchorName.includes(symbol) || symbol.includes(normalizedAnchorName)) {
      return true;
    }
  }

  return false;
}

function findLastPreferredAnchor(candidates: AnchorBlock[]): AnchorBlock | null {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate && (candidate.kind === "function" || candidate.kind === "class")) {
      return candidate;
    }
  }

  return candidates.length > 0 ? (candidates[candidates.length - 1] ?? null) : null;
}

function chooseBestAnchor(candidates: AnchorBlock[], preferredSymbols: Set<string>): AnchorBlock | null {
  if (candidates.length === 0) {
    return null;
  }

  const defaultExportStart = candidates.find((candidate) => candidate.isDefaultExport)?.startLine ?? Number.POSITIVE_INFINITY;
  let best: { candidate: AnchorBlock; score: number } | null = null;

  for (const candidate of candidates) {
    let score = 0;
    const normalizedName = candidate.name?.toLowerCase();

    if (normalizedName && preferredSymbols.has(normalizedName)) {
      score += 200;
    }

    if (candidate.kind === "function") {
      score += 60;
    } else if (candidate.kind === "class") {
      score += 50;
    } else {
      score += 20;
    }

    if (candidate.isExported) {
      score += 25;
    }

    if (candidate.startLine < defaultExportStart) {
      score += 15;
    }

    if (candidate.isDefaultExport) {
      score -= 200;
    }

    score += candidate.startLine / 10_000;

    if (!best || score > best.score) {
      best = { candidate, score };
    }
  }

  return best?.candidate ?? findLastPreferredAnchor(candidates);
}

function findLastMeaningfulBlock(content: string): AnchorBlock | null {
  const lines = content.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      continue;
    }

    return {
      startLine: index,
      endLine: index,
      text: lines[index] ?? "",
      kind: "other",
      name: null,
      isExported: /^export\b/.test(lines[index]?.trim() ?? ""),
      isDefaultExport: /^export\s+default\b/.test(lines[index]?.trim() ?? "")
    };
  }

  return null;
}

function findAnchorBlockForApprovedPatch(
  target: string,
  content: string,
  planGoal: string
): AnchorBlock | null {
  const extension = path.extname(target).toLowerCase();
  const preferredSymbols = extractPreferredSymbols(planGoal, target);

  if (extension === ".ts" || extension === ".tsx" || extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs") {
    const lines = content.split(/\r?\n/);
    const declarationPattern = /^\s*(export\s+)?(async\s+)?(function|class|interface|type)\b|^\s*export\s+(const|let|var)\b|^\s*const\s+[A-Za-z0-9_$]+\s*=\s*(async\s*)?\(/;
    const candidates: AnchorBlock[] = [];
    let depth = 0;
    let currentStart = -1;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const trimmed = line.trim();
      const depthBeforeLine = depth;

      if (currentStart < 0 && depthBeforeLine === 0 && declarationPattern.test(line)) {
        currentStart = index;
      }

      depth += countBraces(line);

      if (currentStart >= 0) {
        const isSingleLine = depthBeforeLine === 0 && depth === 0;
        const closesBlock = depthBeforeLine > 0 && depth === 0;
        const isTypeAlias = /^\s*(export\s+)?type\b/.test(line) && trimmed.endsWith(";");
        const isValueExport = /^\s*export\s+(const|let|var)\b/.test(line) && trimmed.endsWith(";") && depth === 0;

        if (isSingleLine || closesBlock || isTypeAlias || isValueExport) {
          candidates.push({
            startLine: currentStart,
            endLine: index,
            text: lines.slice(currentStart, index + 1).join("\n"),
            kind: inferAnchorKind(lines[currentStart] ?? ""),
            name: inferAnchorName(lines[currentStart] ?? ""),
            ...inferAnchorExportFlags(lines[currentStart] ?? "")
          });
          currentStart = -1;
        }
      }
    }

    if (currentStart >= 0) {
      candidates.push({
        startLine: currentStart,
        endLine: lines.length - 1,
        text: lines.slice(currentStart).join("\n"),
        kind: inferAnchorKind(lines[currentStart] ?? ""),
        name: inferAnchorName(lines[currentStart] ?? ""),
        ...inferAnchorExportFlags(lines[currentStart] ?? "")
      });
    }

    return chooseBestAnchor(candidates, preferredSymbols) ?? findLastMeaningfulBlock(content);
  }

  if (extension === ".py") {
    const lines = content.split(/\r?\n/);
    const startPattern = /^(def|class)\s+[A-Za-z0-9_]+/;
    const candidates: AnchorBlock[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!startPattern.test(line.trim())) {
        continue;
      }

      let end = index;
      for (let next = index + 1; next < lines.length; next += 1) {
        const nextLine = lines[next] ?? "";
        const trimmed = nextLine.trim();
        if (!trimmed) {
          end = next;
          continue;
        }

        if (!nextLine.startsWith(" ") && !nextLine.startsWith("\t")) {
          break;
        }

        end = next;
      }

      candidates.push({
        startLine: index,
        endLine: end,
        text: lines.slice(index, end + 1).join("\n"),
        kind: inferAnchorKind(lines[index] ?? ""),
        name: inferAnchorName(lines[index] ?? ""),
        ...inferAnchorExportFlags(lines[index] ?? "")
      });
    }

    return chooseBestAnchor(candidates, preferredSymbols) ?? findLastMeaningfulBlock(content);
  }

  return findLastMeaningfulBlock(content);
}

function buildFunctionPatchPlan(target: string, contentLines: string[], anchorBlock: AnchorBlock, planGoal: string): FunctionPatchPlan | null {
  const normalizedName = anchorBlock.name?.toLowerCase();
  const preferredSymbols = extractPreferredSymbols(planGoal, target);

  if (anchorBlock.kind !== "function" || !normalizedName || !matchesPreferredSymbol(normalizedName, preferredSymbols)) {
    return null;
  }

  const extension = path.extname(target).toLowerCase();
  const snippetLines = buildFunctionPatchSnippet(target, anchorBlock.name);
  if (snippetLines.length === 0) {
    return null;
  }

  if (extension === ".ts" || extension === ".tsx" || extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs") {
    if (anchorBlock.endLine <= anchorBlock.startLine) {
      return null;
    }

    const headerIndent = countLeadingWhitespace(contentLines[anchorBlock.startLine] ?? "");
    const bodyIndentation = " ".repeat(headerIndent + 2);
    let insertAt = anchorBlock.endLine;

    for (let index = anchorBlock.startLine + 1; index < anchorBlock.endLine; index += 1) {
      const trimmed = (contentLines[index] ?? "").trim();
      if (!trimmed) {
        continue;
      }

      if (trimmed.startsWith("return") || trimmed.startsWith("throw") || trimmed.startsWith("yield")) {
        insertAt = index;
        break;
      }
    }

    return {
      startLine: insertAt,
      endLine: insertAt,
      insertedLines: buildIndentedLines(snippetLines, bodyIndentation)
    };
  }

  if (extension === ".py") {
    const headerIndent = countLeadingWhitespace(contentLines[anchorBlock.startLine] ?? "");
    const bodyIndentation = " ".repeat(headerIndent + 4);
    let insertAt = anchorBlock.endLine + 1;

    for (let index = anchorBlock.startLine + 1; index <= anchorBlock.endLine; index += 1) {
      const trimmed = (contentLines[index] ?? "").trim();
      if (!trimmed) {
        continue;
      }

      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        continue;
      }

      if (trimmed.startsWith("return") || trimmed.startsWith("raise") || trimmed.startsWith("yield")) {
        insertAt = index;
        break;
      }
    }

    return {
      startLine: insertAt,
      endLine: insertAt,
      insertedLines: buildIndentedLines(snippetLines, bodyIndentation)
    };
  }

  return null;
}

function buildReplaceEditPlan(
  target: string,
  currentLines: string[],
  anchorBlock: AnchorBlock,
  planGoal: string
): LineEditPlan {
  const functionPatchPlan = buildFunctionPatchPlan(target, currentLines, anchorBlock, planGoal);
  if (functionPatchPlan) {
    return {
      startLine: functionPatchPlan.startLine,
      deleteCount: functionPatchPlan.endLine - functionPatchPlan.startLine,
      insertedLines: functionPatchPlan.insertedLines
    };
  }

  return {
    startLine: anchorBlock.endLine + 1,
    deleteCount: 0,
    insertedLines: ["", ...buildPatchSnippet(target, planGoal).split("\n")]
  };
}

function applyLineEditPlan(currentLines: string[], plan: LineEditPlan): string[] {
  return [
    ...currentLines.slice(0, plan.startLine),
    ...plan.insertedLines,
    ...currentLines.slice(plan.startLine + plan.deleteCount)
  ];
}

export async function buildApprovedExecutionPlan(
  approval: OrchestrationApprovalRequest & { planGoal: string },
  workspace: string
): Promise<ApprovedExecutionPlan> {
  const absolutePath = resolveWorkspacePath(workspace, approval.target);
  const scaffoldBody = buildWriteScaffold(approval.target, approval.planGoal);

  if (approval.operation === "write") {
    return {
      toolName: "write",
      prompt: `/write ${approval.target} :: ${scaffoldBody}`
    };
  }

  if (approval.operation === "replace") {
    await access(absolutePath);
    const current = await readFile(absolutePath, "utf8");
    const anchorBlock = findAnchorBlockForApprovedPatch(approval.target, current, approval.planGoal);

    if (!anchorBlock) {
      return {
        toolName: "write",
        prompt: `/write ${approval.target} :: ${scaffoldBody}`
      };
    }

    const lines = current.split(/\r?\n/);
    const editPlan = buildReplaceEditPlan(approval.target, lines, anchorBlock, approval.planGoal);
    const replacementLines = applyLineEditPlan(lines, editPlan);
    const replacement = replacementLines.join("\n");
    return {
      toolName: "write",
      prompt: `/write ${approval.target} :: ${replacement}${current.endsWith("\n") ? "\n" : ""}`
    };
  }

  throw new Error(`unsupported approved orchestration operation: ${approval.operation}`);
}
