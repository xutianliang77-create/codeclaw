import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SymbolDefinition, SymbolReference } from "./service";

const execFileAsync = promisify(execFile);

export type LspBackendName = "fallback-regex-index" | "multilspy";
export type LspBridgeQueryKind = "symbol" | "definition" | "references";

export interface LspBackendAssessment {
  activeBackend: LspBackendName;
  fallbackBackend: "fallback-regex-index";
  realBackendCandidate: {
    name: "multilspy";
    status: "not_installed" | "not_enabled" | "ready";
    reason: string;
    pythonCommand?: string;
  };
}

export interface LspBackendProbe {
  pythonCommand: string;
  importable: boolean;
}

export interface RealLspBackend {
  name: "multilspy";
  querySymbols(workspace: string, query: string): Promise<RealLspQueryResponse<SymbolDefinition>>;
  queryDefinitions(workspace: string, query: string): Promise<RealLspQueryResponse<SymbolDefinition>>;
  queryReferences(workspace: string, query: string): Promise<RealLspQueryResponse<SymbolReference>>;
}

export interface RealLspQueryResponse<TItem> {
  degraded: boolean;
  items: TItem[];
}

const assessmentCache = new Map<string, Promise<LspBackendAssessment>>();
const backendCache = new Map<string, Promise<RealLspBackend | null>>();

function getRealLspPreference(): "auto" | "enabled" | "disabled" {
  const rawValue = process.env.CODECLAW_ENABLE_REAL_LSP?.trim().toLowerCase();
  if (!rawValue) {
    return "auto";
  }

  if (rawValue === "1" || rawValue === "true" || rawValue === "on") {
    return "enabled";
  }

  if (rawValue === "0" || rawValue === "false" || rawValue === "off") {
    return "disabled";
  }

  return "auto";
}

function getPythonCandidates(): string[] {
  const candidates: string[] = [];
  const localVenvPython = path.resolve(process.cwd(), ".venv-lsp", "bin", "python");

  if (process.env.CODECLAW_PYTHON) {
    candidates.push(process.env.CODECLAW_PYTHON);
  }

  if (existsSync(localVenvPython)) {
    candidates.push(localVenvPython);
  }

  candidates.push("python3", "python");
  return [...new Set(candidates)];
}

function resolveBridgeScriptPath(): string {
  if (process.env.CODECLAW_LSP_BRIDGE_SCRIPT) {
    return process.env.CODECLAW_LSP_BRIDGE_SCRIPT;
  }

  const candidatePaths = [
    path.resolve(fileURLToPath(new URL("../scripts/lsp_multilspy_bridge.py", import.meta.url))),
    path.resolve(fileURLToPath(new URL("../../scripts/lsp_multilspy_bridge.py", import.meta.url))),
    path.resolve(process.cwd(), "scripts/lsp_multilspy_bridge.py")
  ];

  for (const candidatePath of candidatePaths) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return candidatePaths[candidatePaths.length - 1];
}

async function runPythonProbe(command: string): Promise<LspBackendProbe | null> {
  try {
    const result = await execFileAsync(command, [
      "-c",
      "import importlib.util; print('1' if importlib.util.find_spec('multilspy') else '0')"
    ]);

    return {
      pythonCommand: command,
      importable: result.stdout.trim() === "1"
    };
  } catch {
    return null;
  }
}

async function probeMultilspy(): Promise<LspBackendProbe | null> {
  const candidates = getPythonCandidates();

  for (const command of candidates) {
    const result = await runPythonProbe(command);
    if (result) {
      return result;
    }
  }

  return null;
}

function createAssessmentKey(): string {
  return [
    getRealLspPreference(),
    process.env.CODECLAW_PYTHON ?? "",
    process.env.CODECLAW_LSP_BRIDGE_SCRIPT ?? ""
  ].join(":");
}

export async function assessLspBackend(): Promise<LspBackendAssessment> {
  const cacheKey = createAssessmentKey();
  const cached = assessmentCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (async (): Promise<LspBackendAssessment> => {
    const preference = getRealLspPreference();
    if (preference === "disabled") {
      return {
        activeBackend: "fallback-regex-index",
        fallbackBackend: "fallback-regex-index",
        realBackendCandidate: {
          name: "multilspy",
          status: "not_enabled",
          reason: "real LSP backend explicitly disabled; using fallback-regex-index",
          pythonCommand: process.env.CODECLAW_PYTHON
        }
      };
    }

    const probe = await probeMultilspy();
    if (!probe || !probe.importable) {
      return {
        activeBackend: "fallback-regex-index",
        fallbackBackend: "fallback-regex-index",
        realBackendCandidate: {
          name: "multilspy",
          status: "not_installed",
          reason:
            preference === "enabled"
              ? "real LSP backend requested but multilspy is not importable"
              : "real LSP backend auto-detection did not find an importable multilspy",
          pythonCommand: probe?.pythonCommand
        }
      };
    }

    return {
      activeBackend: "multilspy",
      fallbackBackend: "fallback-regex-index",
      realBackendCandidate: {
        name: "multilspy",
        status: "ready",
        reason:
          preference === "enabled"
            ? `real LSP backend enabled via ${probe.pythonCommand}`
            : `real LSP backend auto-selected via ${probe.pythonCommand}`,
        pythonCommand: probe.pythonCommand
      }
    };
  })();

  assessmentCache.set(cacheKey, pending);
  return pending;
}

async function runBridgeQuery<TItem>(
  pythonCommand: string,
  kind: LspBridgeQueryKind,
  workspace: string,
  query: string
): Promise<RealLspQueryResponse<TItem>> {
  const bridgeScriptPath = resolveBridgeScriptPath();
  const result = await execFileAsync(
    pythonCommand,
    [bridgeScriptPath, "--kind", kind, "--workspace", workspace, "--query", query],
    {
      cwd: workspace,
      maxBuffer: 1024 * 1024
    }
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || "{}");
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown bridge parse error";
    throw new Error(`failed to parse multilspy bridge output: ${message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("multilspy bridge returned a non-object payload");
  }

  const payload = parsed as {
    degraded?: unknown;
    error?: { message?: unknown } | unknown;
    items?: unknown;
  };
  if (payload.error && typeof payload.error === "object" && payload.error !== null) {
    const message =
      "message" in payload.error && typeof payload.error.message === "string"
        ? payload.error.message
        : "multilspy bridge returned an unknown error";
    throw new Error(message);
  }

  if (!Array.isArray(payload.items)) {
    throw new Error("multilspy bridge response is missing an items array");
  }

  return {
    degraded: payload.degraded === true,
    items: payload.items as TItem[]
  };
}

export async function getRealLspBackend(): Promise<RealLspBackend | null> {
  const cacheKey = createAssessmentKey();
  const cached = backendCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const assessment = await assessLspBackend();
  if (assessment.activeBackend !== "multilspy") {
    return null;
  }

  const pythonCommand = assessment.realBackendCandidate.pythonCommand;
  if (!pythonCommand) {
    return null;
  }

  const pending = Promise.resolve({
    name: "multilspy" as const,
    querySymbols(workspace: string, query: string) {
      return runBridgeQuery<SymbolDefinition>(pythonCommand, "symbol", workspace, query);
    },
    queryDefinitions(workspace: string, query: string) {
      return runBridgeQuery<SymbolDefinition>(pythonCommand, "definition", workspace, query);
    },
    queryReferences(workspace: string, query: string) {
      return runBridgeQuery<SymbolReference>(pythonCommand, "references", workspace, query);
    }
  });

  backendCache.set(cacheKey, pending);
  return pending;
}

export function clearLspBackendAssessmentCache(): void {
  assessmentCache.clear();
  backendCache.clear();
}
