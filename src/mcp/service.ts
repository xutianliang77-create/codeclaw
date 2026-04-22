import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const MCP_SERVER_NAME = "workspace-mcp";
const MAX_SEARCH_RESULTS = 20;
const MAX_SNIPPET_CHARS = 2_000;
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

export interface McpServerSummary {
  name: string;
  transport: "in-process";
  status: "connected";
  toolCount: number;
  resourceCount: number;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

function resolveWorkspacePath(workspace: string, target: string): string {
  const absolutePath = path.isAbsolute(target) ? path.resolve(target) : path.resolve(workspace, target);
  const normalizedWorkspace = path.resolve(workspace);

  if (absolutePath !== normalizedWorkspace && !absolutePath.startsWith(`${normalizedWorkspace}${path.sep}`)) {
    throw new Error(`path is outside workspace: ${absolutePath}`);
  }

  return absolutePath;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await readFile(target, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function countWorkspaceFiles(currentDir: string): Promise<number> {
  let count = 0;
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      count += await countWorkspaceFiles(absolutePath);
      continue;
    }

    if (entry.isFile()) {
      count += 1;
    }
  }

  return count;
}

async function collectMatchingFiles(workspace: string, query: string): Promise<string[]> {
  const normalizedWorkspace = path.resolve(workspace);
  const normalizedQuery = query.toLowerCase();
  const results: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    if (results.length >= MAX_SEARCH_RESULTS) {
      return;
    }

    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS) {
        return;
      }

      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = path.relative(normalizedWorkspace, absolutePath);
      if (relativePath.toLowerCase().includes(normalizedQuery)) {
        results.push(relativePath);
      }
    }
  }

  await walk(normalizedWorkspace);
  return results;
}

function ensureServer(serverName: string): void {
  if (serverName !== MCP_SERVER_NAME) {
    throw new Error(`unknown MCP server: ${serverName}`);
  }
}

export async function listMcpServers(workspace: string): Promise<McpServerSummary[]> {
  const resources = await listMcpResources(workspace, MCP_SERVER_NAME);
  const tools = listMcpTools(MCP_SERVER_NAME);

  return [
    {
      name: MCP_SERVER_NAME,
      transport: "in-process",
      status: "connected",
      toolCount: tools.length,
      resourceCount: resources.length
    }
  ];
}

export async function listMcpResources(workspace: string, serverName: string): Promise<McpResourceInfo[]> {
  ensureServer(serverName);
  const resources: McpResourceInfo[] = [
    {
      uri: "workspace://summary",
      name: "workspace-summary",
      description: "High-level workspace summary and file count."
    }
  ];

  if (await pathExists(path.join(workspace, "package.json"))) {
    resources.push({
      uri: "workspace://package-json",
      name: "package-json",
      description: "The root package.json file."
    });
  }

  if (await pathExists(path.join(workspace, "PROGRESS_LOG.md"))) {
    resources.push({
      uri: "workspace://progress-log",
      name: "progress-log",
      description: "The current session progress log."
    });
  }

  return resources;
}

export function listMcpTools(serverName: string): McpToolInfo[] {
  ensureServer(serverName);
  return [
    {
      name: "search-files",
      description: "Search workspace-relative file paths by substring."
    },
    {
      name: "read-snippet",
      description: "Read the first part of a workspace file."
    }
  ];
}

export async function readMcpResource(workspace: string, serverName: string, resourceUri: string): Promise<string> {
  ensureServer(serverName);

  if (resourceUri === "workspace://summary") {
    const fileCount = await countWorkspaceFiles(path.resolve(workspace));
    return [
      "Workspace Summary",
      `workspace: ${path.resolve(workspace)}`,
      `files: ${fileCount}`
    ].join("\n");
  }

  if (resourceUri === "workspace://package-json") {
    return readFile(path.join(workspace, "package.json"), "utf8");
  }

  if (resourceUri === "workspace://progress-log") {
    return readFile(path.join(workspace, "PROGRESS_LOG.md"), "utf8");
  }

  throw new Error(`unknown MCP resource: ${resourceUri}`);
}

export async function callMcpTool(
  workspace: string,
  serverName: string,
  toolName: string,
  input: string
): Promise<string> {
  ensureServer(serverName);

  if (toolName === "search-files") {
    const query = input.trim();
    if (!query) {
      return "Usage: /mcp call workspace-mcp search-files <query>";
    }

    const results = await collectMatchingFiles(workspace, query);
    return [
      `MCP Tool search-files`,
      `query: ${query}`,
      results.length > 0 ? results.map((item) => `- ${item}`).join("\n") : "[no matches]"
    ].join("\n");
  }

  if (toolName === "read-snippet") {
    const target = input.trim();
    if (!target) {
      return "Usage: /mcp call workspace-mcp read-snippet <path>";
    }

    const absolutePath = resolveWorkspacePath(workspace, target);
    const content = await readFile(absolutePath, "utf8");
    const snippet = content.length > MAX_SNIPPET_CHARS ? `${content.slice(0, MAX_SNIPPET_CHARS)}\n...[truncated]` : content;
    return [
      `MCP Tool read-snippet`,
      `path: ${path.relative(path.resolve(workspace), absolutePath) || path.basename(absolutePath)}`,
      "",
      snippet
    ].join("\n");
  }

  throw new Error(`unknown MCP tool: ${toolName}`);
}

