import { execFile } from "node:child_process";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { invalidateWorkspaceIndex, queryDefinitions, queryReferences, querySymbols } from "../lsp/service";
import { PermissionManager } from "../permissions/manager";
import type { PermissionDecision } from "../permissions/manager";
import {
  buildToolErrorResult,
  buildToolSuccessResult,
  isHandledToolExecutionOutcome,
  type ToolExecutionError,
  type ToolExecutionOutcome,
  type ToolExecutionResult
} from "./types";

const execFileAsync = promisify(execFile);
const MAX_READ_CHARS = 12_000;
const MAX_COMMAND_OUTPUT_CHARS = 12_000;
const MAX_GLOB_RESULTS = 200;
const SKIPPED_WORKSPACE_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "coverage",
  ".venv",
  ".venv-lsp",
  "__pycache__"
]);

export interface LocalToolOptions {
  workspace: string;
  permissions: PermissionManager;
}

export type LocalToolName =
  | "read"
  | "glob"
  | "symbol"
  | "definition"
  | "references"
  | "bash"
  | "write"
  | "append"
  | "replace";
export type LocalToolErrorCode = "permission_denied" | "approval_required" | "tool_failed";
export type LocalToolResult = ToolExecutionOutcome<LocalToolName, LocalToolErrorCode>;
export type LocalToolExecutionResult = ToolExecutionResult<LocalToolName>;
export type LocalToolExecutionError = ToolExecutionError<LocalToolName, LocalToolErrorCode>;

export interface LocalToolInspection {
  handled: boolean;
  toolName?: LocalToolName;
  decision?: PermissionDecision;
  detail?: string;
}

export function isHandledLocalToolResult(
  result: LocalToolResult
): result is LocalToolExecutionResult | LocalToolExecutionError {
  return isHandledToolExecutionOutcome(result);
}

export function detectLocalTool(prompt: string): LocalToolName | null {
  if (prompt.startsWith("/read")) {
    return "read";
  }

  if (prompt.startsWith("/bash")) {
    return "bash";
  }

  if (prompt.startsWith("/glob")) {
    return "glob";
  }

  if (prompt.startsWith("/symbol")) {
    return "symbol";
  }

  if (prompt.startsWith("/definition")) {
    return "definition";
  }

  if (prompt.startsWith("/references")) {
    return "references";
  }

  if (prompt.startsWith("/write")) {
    return "write";
  }

  if (prompt.startsWith("/append")) {
    return "append";
  }

  if (prompt.startsWith("/replace")) {
    return "replace";
  }

  return null;
}

export function inspectLocalTool(prompt: string, permissions: PermissionManager): LocalToolInspection {
  if (prompt.startsWith("/read")) {
    const target = prompt.slice("/read".length).trim();
    return {
      handled: true,
      toolName: "read",
      decision: permissions.evaluate({
        tool: "read",
        target
      }),
      detail: target
    };
  }

  if (prompt.startsWith("/bash")) {
    const command = prompt.slice("/bash".length).trim();
    return {
      handled: true,
      toolName: "bash",
      decision: permissions.evaluate({
        tool: "bash",
        command
      }),
      detail: command
    };
  }

  if (prompt.startsWith("/glob")) {
    const pattern = prompt.slice("/glob".length).trim();
    return {
      handled: true,
      toolName: "glob",
      decision: permissions.evaluate({
        tool: "glob",
        target: pattern
      }),
      detail: pattern
    };
  }

  if (prompt.startsWith("/symbol")) {
    const query = prompt.slice("/symbol".length).trim();
    return {
      handled: true,
      toolName: "symbol",
      decision: permissions.evaluate({
        tool: "symbol",
        target: query
      }),
      detail: query
    };
  }

  if (prompt.startsWith("/definition")) {
    const query = prompt.slice("/definition".length).trim();
    return {
      handled: true,
      toolName: "definition",
      decision: permissions.evaluate({
        tool: "definition",
        target: query
      }),
      detail: query
    };
  }

  if (prompt.startsWith("/references")) {
    const query = prompt.slice("/references".length).trim();
    return {
      handled: true,
      toolName: "references",
      decision: permissions.evaluate({
        tool: "references",
        target: query
      }),
      detail: query
    };
  }

  if (prompt.startsWith("/write")) {
    const payload = prompt.slice("/write".length).trim();
    const parsed = parseDoubleColonParts(payload, 2);
    const target = parsed?.[0] ?? "";
    return {
      handled: true,
      toolName: "write",
      decision: permissions.evaluate({
        tool: "write",
        target
      }),
      detail: target
    };
  }

  if (prompt.startsWith("/append")) {
    const payload = prompt.slice("/append".length).trim();
    const parsed = parseDoubleColonParts(payload, 2);
    const target = parsed?.[0] ?? "";
    return {
      handled: true,
      toolName: "append",
      decision: permissions.evaluate({
        tool: "append",
        target
      }),
      detail: target
    };
  }

  if (prompt.startsWith("/replace")) {
    const payload = prompt.slice("/replace".length).trim();
    const parsed = parseDoubleColonParts(payload, 3);
    const target = parsed?.[0] ?? "";
    return {
      handled: true,
      toolName: "replace",
      decision: permissions.evaluate({
        tool: "replace",
        target
      }),
      detail: target
    };
  }

  return {
    handled: false
  };
}

function parseDoubleColonParts(input: string, count: number): string[] | null {
  const parts = input.split("::").map((part) => part.trim());
  return parts.length >= count ? parts : null;
}

function resolveWorkspacePath(workspace: string, target: string): string {
  const absolutePath = path.isAbsolute(target) ? path.resolve(target) : path.resolve(workspace, target);
  const normalizedWorkspace = path.resolve(workspace);

  if (absolutePath !== normalizedWorkspace && !absolutePath.startsWith(`${normalizedWorkspace}${path.sep}`)) {
    throw new Error(`path is outside workspace: ${absolutePath}`);
  }

  return absolutePath;
}

function toWorkspaceRelativePath(workspace: string, target: string): string {
  return path.relative(path.resolve(workspace), resolveWorkspacePath(workspace, target)).replace(/\\/g, "/");
}

function trimOutput(output: string, limit: number): string {
  if (output.length <= limit) {
    return output;
  }

  return `${output.slice(0, limit)}\n... [truncated]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globPatternToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let source = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*" && next === "*") {
      const afterNext = normalized[index + 2];
      if (afterNext === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(char);
  }

  source += "$";
  return new RegExp(source);
}

async function collectWorkspaceFiles(currentDir: string, relativePrefix = ""): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (SKIPPED_WORKSPACE_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await collectWorkspaceFiles(absolutePath, relativePath)));
      if (files.length >= MAX_GLOB_RESULTS) {
        return files.slice(0, MAX_GLOB_RESULTS);
      }
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
      if (files.length >= MAX_GLOB_RESULTS) {
        return files.slice(0, MAX_GLOB_RESULTS);
      }
    }
  }

  return files;
}

async function runReadTool(target: string, workspace: string): Promise<string> {
  if (!target.trim()) {
    return "Usage: /read <path>";
  }

  const absolutePath = resolveWorkspacePath(workspace, target.trim());
  const content = await readFile(absolutePath, "utf8");

  return [`Read ${absolutePath}`, "", trimOutput(content, MAX_READ_CHARS)].join("\n");
}

async function runGlobTool(pattern: string, workspace: string): Promise<string> {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) {
    return "Usage: /glob <pattern>";
  }

  const matcher = globPatternToRegExp(normalizedPattern);
  const files = await collectWorkspaceFiles(workspace);
  const matches = files.filter((file) => matcher.test(file.replace(/\\/g, "/"))).slice(0, MAX_GLOB_RESULTS);

  if (matches.length === 0) {
    return `Glob ${normalizedPattern}\n\n[no matches]`;
  }

  return [`Glob ${normalizedPattern}`, "", ...matches].join("\n");
}

async function runSymbolTool(query: string, workspace: string): Promise<string> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return "Usage: /symbol <name>";
  }

  const result = await querySymbols(workspace, normalizedQuery);
  const backendLine = `LSPTool backend: ${result.backend}${result.degraded ? " (degraded)" : ""}`;
  if (result.items.length === 0) {
    return [backendLine, `symbol: ${normalizedQuery}`, "", "[no matches]"].join("\n");
  }

  return [
    backendLine,
    `real backend candidate: ${result.backendAssessment.realBackendCandidate.name} (${result.backendAssessment.realBackendCandidate.status})`,
    `symbol: ${normalizedQuery}`,
    `index: ${result.index.sourceFileCount} files / ${result.index.symbolCount} symbols`,
    "",
    ...result.items.map(
      (item, index) =>
        `${index + 1}. ${item.kind} ${item.name}\n   ${item.file}:${item.line}:${item.column}\n   ${item.snippet}`
    )
  ].join("\n");
}

async function runDefinitionTool(query: string, workspace: string): Promise<string> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return "Usage: /definition <name>";
  }

  const result = await queryDefinitions(workspace, normalizedQuery);
  const backendLine = `LSPTool backend: ${result.backend}${result.degraded ? " (degraded)" : ""}`;
  if (result.items.length === 0) {
    return [backendLine, `definition: ${normalizedQuery}`, "", "[not found]"].join("\n");
  }

  const item = result.items[0];
  return [
    backendLine,
    `real backend candidate: ${result.backendAssessment.realBackendCandidate.name} (${result.backendAssessment.realBackendCandidate.status})`,
    `definition: ${normalizedQuery}`,
    `index: ${result.index.sourceFileCount} files / ${result.index.symbolCount} symbols`,
    "",
    `${item.kind} ${item.name}`,
    `${item.file}:${item.line}:${item.column}`,
    item.snippet
  ].join("\n");
}

async function runReferencesTool(query: string, workspace: string): Promise<string> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return "Usage: /references <name>";
  }

  const result = await queryReferences(workspace, normalizedQuery);
  const backendLine = `LSPTool backend: ${result.backend}${result.degraded ? " (degraded)" : ""}`;
  if (result.items.length === 0) {
    return [backendLine, `references: ${normalizedQuery}`, "", "[no matches]"].join("\n");
  }

  return [
    backendLine,
    `real backend candidate: ${result.backendAssessment.realBackendCandidate.name} (${result.backendAssessment.realBackendCandidate.status})`,
    `references: ${normalizedQuery}`,
    `index: ${result.index.sourceFileCount} files / ${result.index.symbolCount} symbols`,
    `matches: ${result.items.length}`,
    "",
    ...result.items.map(
      (item, index) => `${index + 1}. [${item.relation}] ${item.file}:${item.line}:${item.column}\n   ${item.snippet}`
    )
  ].join("\n");
}

async function runBashTool(command: string, workspace: string): Promise<string> {
  if (!command.trim()) {
    return "Usage: /bash <command>";
  }

  try {
    const result = await execFileAsync("zsh", ["-lc", command], {
      cwd: workspace,
      timeout: 10_000,
      maxBuffer: 128 * 1024
    });
    const combined = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

    return [`Bash: ${command}`, "", trimOutput(combined || "[no output]", MAX_COMMAND_OUTPUT_CHARS)].join("\n");
  } catch (error) {
    const execError = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: string;
      killed?: boolean;
    };
    const combined = [execError.stdout, execError.stderr, execError.message].filter(Boolean).join("\n").trim();
    const exitLabel = execError.killed ? "timed out" : `failed (${execError.code ?? execError.signal ?? "unknown"})`;

    return [`Bash: ${command}`, "", `${exitLabel}`, "", trimOutput(combined, MAX_COMMAND_OUTPUT_CHARS)].join("\n");
  }
}

async function runWriteTool(target: string, content: string, workspace: string): Promise<string> {
  if (!target.trim()) {
    return "Usage: /write <path> :: <content>";
  }

  const absolutePath = resolveWorkspacePath(workspace, target.trim());
  await writeFile(absolutePath, content, "utf8");
  invalidateWorkspaceIndex(workspace, toWorkspaceRelativePath(workspace, target.trim()));

  return `Wrote ${content.length} chars to ${absolutePath}`;
}

async function runAppendTool(target: string, content: string, workspace: string): Promise<string> {
  if (!target.trim()) {
    return "Usage: /append <path> :: <content>";
  }

  const absolutePath = resolveWorkspacePath(workspace, target.trim());
  await appendFile(absolutePath, content, "utf8");
  invalidateWorkspaceIndex(workspace, toWorkspaceRelativePath(workspace, target.trim()));

  return `Appended ${content.length} chars to ${absolutePath}`;
}

async function runReplaceTool(target: string, findText: string, replaceText: string, workspace: string): Promise<string> {
  if (!target.trim()) {
    return "Usage: /replace <path> :: <find> :: <replace>";
  }

  const absolutePath = resolveWorkspacePath(workspace, target.trim());
  const current = await readFile(absolutePath, "utf8");

  if (!findText) {
    return "Replace failed: <find> cannot be empty";
  }

  if (!current.includes(findText)) {
    return `Replace failed: target text not found in ${absolutePath}`;
  }

  const next = current.replace(findText, replaceText);
  await writeFile(absolutePath, next, "utf8");
  invalidateWorkspaceIndex(workspace, toWorkspaceRelativePath(workspace, target.trim()));

  return `Replaced first match in ${absolutePath}`;
}

export async function runLocalTool(prompt: string, workspace: string): Promise<LocalToolResult> {
  if (prompt.startsWith("/read")) {
    const target = prompt.slice("/read".length).trim();

    try {
      return buildToolSuccessResult("read", `Read ${target || "[missing path]"}`, await runReadTool(target, workspace));
    } catch (error) {
      return buildToolErrorResult("read", "failed", "tool_failed", "Read failed", (error as Error).message);
    }
  }

  if (prompt.startsWith("/bash")) {
    const command = prompt.slice("/bash".length).trim();

    return buildToolSuccessResult("bash", `Bash: ${command || "[missing command]"}`, await runBashTool(command, workspace));
  }

  if (prompt.startsWith("/glob")) {
    const pattern = prompt.slice("/glob".length).trim();

    try {
      return buildToolSuccessResult("glob", `Glob ${pattern || "[missing pattern]"}`, await runGlobTool(pattern, workspace));
    } catch (error) {
      return buildToolErrorResult("glob", "failed", "tool_failed", "Glob failed", (error as Error).message);
    }
  }

  if (prompt.startsWith("/symbol")) {
    const query = prompt.slice("/symbol".length).trim();

    try {
      return buildToolSuccessResult(
        "symbol",
        `Symbol ${query || "[missing query]"}`,
        await runSymbolTool(query, workspace)
      );
    } catch (error) {
      return buildToolErrorResult("symbol", "failed", "tool_failed", "Symbol query failed", (error as Error).message);
    }
  }

  if (prompt.startsWith("/definition")) {
    const query = prompt.slice("/definition".length).trim();

    try {
      return buildToolSuccessResult(
        "definition",
        `Definition ${query || "[missing query]"}`,
        await runDefinitionTool(query, workspace)
      );
    } catch (error) {
      return buildToolErrorResult(
        "definition",
        "failed",
        "tool_failed",
        "Definition query failed",
        (error as Error).message
      );
    }
  }

  if (prompt.startsWith("/references")) {
    const query = prompt.slice("/references".length).trim();

    try {
      return buildToolSuccessResult(
        "references",
        `References ${query || "[missing query]"}`,
        await runReferencesTool(query, workspace)
      );
    } catch (error) {
      return buildToolErrorResult(
        "references",
        "failed",
        "tool_failed",
        "References query failed",
        (error as Error).message
      );
    }
  }

  if (prompt.startsWith("/write")) {
    const payload = prompt.slice("/write".length).trim();
    const parsed = parseDoubleColonParts(payload, 2);

    try {
      return buildToolSuccessResult(
        "write",
        `Write ${parsed?.[0] || "[missing path]"}`,
        parsed ? await runWriteTool(parsed[0], parsed.slice(1).join(" :: "), workspace) : "Usage: /write <path> :: <content>"
      );
    } catch (error) {
      return buildToolErrorResult("write", "failed", "tool_failed", "Write failed", (error as Error).message);
    }
  }

  if (prompt.startsWith("/append")) {
    const payload = prompt.slice("/append".length).trim();
    const parsed = parseDoubleColonParts(payload, 2);

    try {
      return buildToolSuccessResult(
        "append",
        `Append ${parsed?.[0] || "[missing path]"}`,
        parsed ? await runAppendTool(parsed[0], parsed.slice(1).join(" :: "), workspace) : "Usage: /append <path> :: <content>"
      );
    } catch (error) {
      return buildToolErrorResult("append", "failed", "tool_failed", "Append failed", (error as Error).message);
    }
  }

  if (prompt.startsWith("/replace")) {
    const payload = prompt.slice("/replace".length).trim();
    const parsed = parseDoubleColonParts(payload, 3);

    try {
      return buildToolSuccessResult(
        "replace",
        `Replace ${parsed?.[0] || "[missing path]"}`,
        parsed
          ? await runReplaceTool(parsed[0], parsed[1], parsed.slice(2).join(" :: "), workspace)
          : "Usage: /replace <path> :: <find> :: <replace>"
      );
    } catch (error) {
      return buildToolErrorResult("replace", "failed", "tool_failed", "Replace failed", (error as Error).message);
    }
  }

  return {
    handled: false,
    output: ""
  };
}

export async function maybeRunLocalTool(
  prompt: string,
  options: LocalToolOptions
): Promise<LocalToolResult> {
  const inspection = inspectLocalTool(prompt, options.permissions);
  if (!inspection.handled || !inspection.toolName || !inspection.decision) {
    return {
      handled: false,
      output: ""
    };
  }

  if (inspection.decision.behavior === "deny") {
    return buildToolErrorResult(
      inspection.toolName,
      "blocked",
      "permission_denied",
      `${inspection.toolName[0].toUpperCase()}${inspection.toolName.slice(1)} blocked`,
      inspection.decision.reason
    );
  }

  if (inspection.decision.behavior === "ask") {
    return buildToolErrorResult(
      inspection.toolName,
      "pending",
      "approval_required",
      `Approval required for ${inspection.toolName}`,
      inspection.decision.reason
    );
  }

  return runLocalTool(prompt, options.workspace);
}
