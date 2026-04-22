import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { assessLspBackend, getRealLspBackend, type LspBackendAssessment, type LspBackendName } from "./backend";

export type LspQueryKind = "symbol" | "definition" | "references";
export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "const"
  | "module"
  | "namespace"
  | "component"
  | "c-family"
  | "python"
  | "ruby"
  | "php"
  | "kotlin"
  | "swift"
  | "csharp"
  | "go"
  | "rust";

export interface SymbolDefinition {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  column: number;
  snippet: string;
}

export interface SymbolReference {
  relation: "definition" | "reference";
  file: string;
  line: number;
  column: number;
  snippet: string;
}

export interface LspQueryResult<TItem> {
  backend: LspBackendName;
  degraded: boolean;
  items: TItem[];
  index: {
    workspace: string;
    sourceFileCount: number;
    symbolCount: number;
    builtAt: string;
  };
  backendAssessment: LspBackendAssessment;
}

type WorkspaceIndex = {
  workspace: string;
  sourceFiles: string[];
  symbols: SymbolDefinition[];
  symbolsByFile: Map<string, SymbolDefinition[]>;
  fileMtimes: Map<string, number>;
  builtAt: string;
};

const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".kt",
  ".kts",
  ".rb",
  ".php",
  ".swift",
  ".cs",
  ".go",
  ".rs",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp"
]);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "coverage",
  ".venv",
  ".venv-lsp",
  "__pycache__"
]);
const MAX_FILES = 800;
const MAX_SYMBOL_RESULTS = 20;
const MAX_REFERENCE_RESULTS = 40;

const SYMBOL_PATTERNS: Array<{ kind: SymbolKind; pattern: RegExp }> = [
  { kind: "function", pattern: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: "method", pattern: /\b(?:public|private|protected|static|async|\s)*([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/ },
  { kind: "class", pattern: /\b(?:export\s+)?class\s+([A-Za-z_]\w*)\b/ },
  { kind: "interface", pattern: /\b(?:export\s+)?interface\s+([A-Za-z_]\w*)\b/ },
  { kind: "type", pattern: /\b(?:export\s+)?type\s+([A-Za-z_]\w*)\b/ },
  { kind: "enum", pattern: /\b(?:export\s+)?enum\s+([A-Za-z_]\w*)\b/ },
  { kind: "component", pattern: /\b(?:export\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*\([^)]*\)\s*=>/ },
  { kind: "const", pattern: /\b(?:export\s+)?const\s+([A-Za-z_]\w*)\b/ },
  { kind: "variable", pattern: /\b(?:export\s+)?(?:let|var)\s+([A-Za-z_]\w*)\b/ },
  { kind: "module", pattern: /\b(?:export\s+)?module\s+([A-Za-z_]\w*)\b/ },
  { kind: "namespace", pattern: /\b(?:export\s+)?namespace\s+([A-Za-z_]\w*)\b/ },
  { kind: "python", pattern: /^\s*def\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: "python", pattern: /^\s*class\s+([A-Za-z_]\w*)\b/ },
  { kind: "ruby", pattern: /^\s*def\s+([A-Za-z_]\w*[!?=]?)\b/ },
  { kind: "ruby", pattern: /^\s*class\s+([A-Za-z_]\w*)\b/ },
  { kind: "php", pattern: /^\s*function\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: "php", pattern: /^\s*class\s+([A-Za-z_]\w*)\b/ },
  { kind: "kotlin", pattern: /^\s*fun\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: "kotlin", pattern: /^\s*(?:data\s+)?class\s+([A-Za-z_]\w*)\b/ },
  { kind: "swift", pattern: /^\s*func\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: "swift", pattern: /^\s*(?:struct|class|protocol|enum)\s+([A-Za-z_]\w*)\b/ },
  { kind: "csharp", pattern: /^\s*(?:public|private|internal|protected|static|sealed|partial|\s)+class\s+([A-Za-z_]\w*)\b/ },
  { kind: "csharp", pattern: /^\s*(?:public|private|internal|protected|static|async|\s)+(?:void|Task|[A-Za-z_][\w<>]*)\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: "go", pattern: /^\s*func\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: "go", pattern: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/ },
  { kind: "rust", pattern: /^\s*fn\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: "rust", pattern: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)\b/ },
  { kind: "c-family", pattern: /^\s*(?:static\s+|inline\s+|constexpr\s+|virtual\s+|const\s+)*[A-Za-z_][\w:<>\s*&]*\s+([A-Za-z_]\w*)\s*\([^;{)]*\)\s*(?:\{|$)/ },
  { kind: "c-family", pattern: /^\s*(?:class|struct|enum)\s+([A-Za-z_]\w*)\b/ }
];

const workspaceIndexes = new Map<string, WorkspaceIndex>();

function normalizeSnippet(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

function shouldSkipPotentialMethod(line: string, name: string): boolean {
  const normalized = line.trim();
  return (
    name === "if" ||
    name === "for" ||
    name === "while" ||
    name === "switch" ||
    name === "catch" ||
    normalized.startsWith("function ") ||
    normalized.startsWith("export function ") ||
    normalized.startsWith("const ") ||
    normalized.startsWith("let ") ||
    normalized.startsWith("var ")
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function collectSourceFiles(
  workspace: string,
  currentDir = workspace,
  relativePrefix = ""
): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(workspace, absolutePath, relativePath)));
      if (files.length >= MAX_FILES) {
        return files.slice(0, MAX_FILES);
      }
      continue;
    }

    if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(relativePath);
      if (files.length >= MAX_FILES) {
        return files.slice(0, MAX_FILES);
      }
    }
  }

  return files;
}

function buildFileSymbols(file: string, content: string): SymbolDefinition[] {
  const lines = content.split(/\r?\n/);
  const fileSymbols: SymbolDefinition[] = [];

  for (const [lineIndex, line] of lines.entries()) {
    for (const { kind, pattern } of SYMBOL_PATTERNS) {
      const match = line.match(pattern);
      const name = match?.[1];
      if (!name) {
        continue;
      }

      if (kind === "method" && shouldSkipPotentialMethod(line, name)) {
        continue;
      }

      fileSymbols.push({
        name,
        kind,
        file,
        line: lineIndex + 1,
        column: line.indexOf(name) + 1,
        snippet: normalizeSnippet(line)
      });
    }
  }

  return fileSymbols;
}

async function buildWorkspaceIndex(workspace: string): Promise<WorkspaceIndex> {
  const files = await collectSourceFiles(workspace);
  const symbolsByFile = new Map<string, SymbolDefinition[]>();
  const fileMtimes = new Map<string, number>();
  const symbols: SymbolDefinition[] = [];

  for (const file of files) {
    const absolutePath = path.join(workspace, file);
    let content = "";
    let mtimeMs = 0;

    try {
      const metadata = await stat(absolutePath);
      mtimeMs = metadata.mtimeMs;
      content = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }

    fileMtimes.set(file, mtimeMs);
    const fileSymbols = buildFileSymbols(file, content);
    symbols.push(...fileSymbols);

    symbolsByFile.set(file, fileSymbols);
  }

  return {
    workspace,
    sourceFiles: files,
    symbols,
    symbolsByFile,
    fileMtimes,
    builtAt: new Date().toISOString()
  };
}

async function getWorkspaceIndex(workspace: string): Promise<WorkspaceIndex> {
  const normalizedWorkspace = path.resolve(workspace);
  const cached = workspaceIndexes.get(normalizedWorkspace);
  if (cached) {
    return cached;
  }

  const index = await buildWorkspaceIndex(normalizedWorkspace);
  workspaceIndexes.set(normalizedWorkspace, index);
  return index;
}

async function refreshChangedFiles(workspace: string, index: WorkspaceIndex): Promise<WorkspaceIndex> {
  const sourceFiles = await collectSourceFiles(workspace);
  const nextFileSet = new Set(sourceFiles);
  const currentFileSet = new Set(index.sourceFiles);
  let dirty = sourceFiles.length !== index.sourceFiles.length;
  const nextSymbolsByFile = new Map(index.symbolsByFile);
  const nextFileMtimes = new Map(index.fileMtimes);

  for (const removedFile of index.sourceFiles) {
    if (!nextFileSet.has(removedFile)) {
      dirty = true;
      nextSymbolsByFile.delete(removedFile);
      nextFileMtimes.delete(removedFile);
    }
  }

  for (const file of sourceFiles) {
    const absolutePath = path.join(workspace, file);
    let metadataMtime = 0;
    try {
      metadataMtime = (await stat(absolutePath)).mtimeMs;
    } catch {
      dirty = true;
      nextSymbolsByFile.delete(file);
      nextFileMtimes.delete(file);
      continue;
    }

    if (!currentFileSet.has(file) || nextFileMtimes.get(file) !== metadataMtime) {
      dirty = true;
      nextFileMtimes.set(file, metadataMtime);
      let content = "";
      try {
        content = await readFile(absolutePath, "utf8");
      } catch {
        nextSymbolsByFile.delete(file);
        continue;
      }

      nextSymbolsByFile.set(file, buildFileSymbols(file, content));
    }
  }

  if (!dirty) {
    return index;
  }

  const symbols = sourceFiles.flatMap((file) => nextSymbolsByFile.get(file) ?? []);
  const nextIndex: WorkspaceIndex = {
    workspace,
    sourceFiles,
    symbols,
    symbolsByFile: nextSymbolsByFile,
    fileMtimes: nextFileMtimes,
    builtAt: new Date().toISOString()
  };
  workspaceIndexes.set(workspace, nextIndex);
  return nextIndex;
}

async function getFreshWorkspaceIndex(workspace: string): Promise<WorkspaceIndex> {
  const normalizedWorkspace = path.resolve(workspace);
  const cached = workspaceIndexes.get(normalizedWorkspace);
  if (!cached) {
    return getWorkspaceIndex(normalizedWorkspace);
  }

  return refreshChangedFiles(normalizedWorkspace, cached);
}

function buildIndexSnapshot(workspace: string, index: WorkspaceIndex) {
  return {
    workspace,
    sourceFileCount: index.sourceFiles.length,
    symbolCount: index.symbols.length,
    builtAt: index.builtAt
  };
}

function rankDefinitionMatch(symbol: SymbolDefinition, query: string): number {
  const lowerName = symbol.name.toLowerCase();
  const lowerQuery = query.toLowerCase();

  if (lowerName === lowerQuery) {
    return 0;
  }

  if (lowerName.startsWith(lowerQuery)) {
    return 1;
  }

  return 2;
}

function getSymbolKindPriority(kind: SymbolKind): number {
  switch (kind) {
    case "function":
    case "method":
    case "class":
    case "interface":
    case "type":
    case "enum":
    case "component":
      return 0;
    case "const":
    case "variable":
    case "module":
    case "namespace":
      return 1;
    default:
      return 2;
  }
}

export async function querySymbols(workspace: string, query: string): Promise<LspQueryResult<SymbolDefinition>> {
  const normalizedQuery = query.trim();
  const normalizedWorkspace = path.resolve(workspace);
  const index = await getFreshWorkspaceIndex(normalizedWorkspace);
  const backendAssessment = await assessLspBackend();
  if (!normalizedQuery) {
    return {
      backend: "fallback-regex-index",
      degraded: true,
      items: [],
      index: buildIndexSnapshot(normalizedWorkspace, index),
      backendAssessment
    };
  }

  const realBackend = await getRealLspBackend();
  if (realBackend) {
    try {
      const response = await realBackend.querySymbols(normalizedWorkspace, normalizedQuery);
      return {
        backend: backendAssessment.activeBackend,
        degraded: response.degraded,
        items: response.items.slice(0, MAX_SYMBOL_RESULTS),
        index: buildIndexSnapshot(normalizedWorkspace, index),
        backendAssessment
      };
    } catch {
      // Fall through to the in-process regex index when the real backend bridge fails.
    }
  }

  const items = index.symbols
    .filter((symbol) => symbol.name.toLowerCase().includes(normalizedQuery.toLowerCase()))
    .sort((left, right) => {
      const rankDiff = rankDefinitionMatch(left, normalizedQuery) - rankDefinitionMatch(right, normalizedQuery);
      if (rankDiff !== 0) {
        return rankDiff;
      }

      const kindDiff = getSymbolKindPriority(left.kind) - getSymbolKindPriority(right.kind);
      if (kindDiff !== 0) {
        return kindDiff;
      }

      return left.file.localeCompare(right.file) || left.line - right.line;
    })
    .slice(0, MAX_SYMBOL_RESULTS);

  return {
    backend: "fallback-regex-index",
    degraded: true,
    items,
    index: buildIndexSnapshot(normalizedWorkspace, index),
    backendAssessment
  };
}

export async function queryDefinitions(workspace: string, query: string): Promise<LspQueryResult<SymbolDefinition>> {
  const normalizedQuery = query.trim();
  const normalizedWorkspace = path.resolve(workspace);
  const index = await getFreshWorkspaceIndex(normalizedWorkspace);
  const backendAssessment = await assessLspBackend();
  if (!normalizedQuery) {
    return {
      backend: "fallback-regex-index",
      degraded: true,
      items: [],
      index: buildIndexSnapshot(normalizedWorkspace, index),
      backendAssessment
    };
  }

  const realBackend = await getRealLspBackend();
  if (realBackend) {
    try {
      const response = await realBackend.queryDefinitions(normalizedWorkspace, normalizedQuery);
      return {
        backend: backendAssessment.activeBackend,
        degraded: response.degraded,
        items: response.items.slice(0, 1),
        index: buildIndexSnapshot(normalizedWorkspace, index),
        backendAssessment
      };
    } catch {
      // Fall through to the in-process regex index when the real backend bridge fails.
    }
  }

  const result = await querySymbols(normalizedWorkspace, normalizedQuery);
  return {
    ...result,
    items: result.items.slice(0, 1)
  };
}

export async function queryReferences(workspace: string, query: string): Promise<LspQueryResult<SymbolReference>> {
  const normalizedQuery = query.trim();
  const normalizedWorkspace = path.resolve(workspace);
  const index = await getFreshWorkspaceIndex(normalizedWorkspace);
  const backendAssessment = await assessLspBackend();
  if (!normalizedQuery) {
    return {
      backend: "fallback-regex-index",
      degraded: true,
      items: [],
      index: buildIndexSnapshot(normalizedWorkspace, index),
      backendAssessment
    };
  }

  const realBackend = await getRealLspBackend();
  if (realBackend) {
    try {
      const response = await realBackend.queryReferences(normalizedWorkspace, normalizedQuery);
      return {
        backend: backendAssessment.activeBackend,
        degraded: response.degraded,
        items: response.items.slice(0, MAX_REFERENCE_RESULTS),
        index: buildIndexSnapshot(normalizedWorkspace, index),
        backendAssessment
      };
    } catch {
      // Fall through to the in-process regex index when the real backend bridge fails.
    }
  }

  const pattern = new RegExp(`\\b${escapeRegExp(normalizedQuery)}\\b`);
  const items: SymbolReference[] = [];
  const seen = new Set<string>();
  const definitionLocations = new Set(
    index.symbols
      .filter((symbol) => symbol.name === normalizedQuery)
      .map((symbol) => `${symbol.file}:${symbol.line}`)
  );

  for (const file of index.sourceFiles) {
    const absolutePath = path.join(normalizedWorkspace, file);
    let content = "";

    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (const [lineIndex, line] of lines.entries()) {
      const match = line.match(pattern);
      if (!match) {
        continue;
      }

      const dedupeKey = `${file}:${lineIndex + 1}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      items.push({
        relation: definitionLocations.has(dedupeKey) ? "definition" : "reference",
        file,
        line: lineIndex + 1,
        column: match.index !== undefined ? match.index + 1 : 1,
        snippet: normalizeSnippet(line)
      });

      if (items.length >= MAX_REFERENCE_RESULTS) {
        return {
          backend: "fallback-regex-index",
          degraded: true,
          items: items.sort((left, right) => {
            if (left.relation !== right.relation) {
              return left.relation === "definition" ? -1 : 1;
            }

            return left.file.localeCompare(right.file) || left.line - right.line;
          }),
          index: buildIndexSnapshot(normalizedWorkspace, index),
          backendAssessment
        };
      }
    }
  }

  return {
    backend: "fallback-regex-index",
    degraded: true,
    items: items.sort((left, right) => {
      if (left.relation !== right.relation) {
        return left.relation === "definition" ? -1 : 1;
      }

      return left.file.localeCompare(right.file) || left.line - right.line;
    }),
    index: buildIndexSnapshot(normalizedWorkspace, index),
    backendAssessment
  };
}

export async function getWorkspaceIndexState(workspace: string): Promise<{
  workspace: string;
  sourceFileCount: number;
  symbolCount: number;
  builtAt: string;
}> {
  const index = await getFreshWorkspaceIndex(workspace);
  return {
    workspace: index.workspace,
    sourceFileCount: index.sourceFiles.length,
    symbolCount: index.symbols.length,
    builtAt: index.builtAt
  };
}

export function invalidateWorkspaceIndex(workspace: string, relativeFile?: string): void {
  const normalizedWorkspace = path.resolve(workspace);
  const cached = workspaceIndexes.get(normalizedWorkspace);
  if (!cached) {
    return;
  }

  if (!relativeFile) {
    workspaceIndexes.delete(normalizedWorkspace);
    return;
  }

  cached.fileMtimes.delete(relativeFile);
  cached.symbolsByFile.delete(relativeFile);
  cached.sourceFiles = cached.sourceFiles.filter((file) => file !== relativeFile);
}

export function clearWorkspaceIndexCache(): void {
  workspaceIndexes.clear();
}
