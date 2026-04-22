import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callMcpTool, listMcpResources, listMcpServers, listMcpTools, readMcpResource } from "../src/mcp/service";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("mcp service", () => {
  it("lists the built-in workspace MCP server, resources, and tools", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-mcp-"));
    tempDirs.push(workspace);
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "codeclaw" }), "utf8");
    await writeFile(path.join(workspace, "PROGRESS_LOG.md"), "progress", "utf8");

    const servers = await listMcpServers(workspace);
    const resources = await listMcpResources(workspace, "workspace-mcp");
    const tools = listMcpTools("workspace-mcp");

    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe("workspace-mcp");
    expect(resources.some((resource) => resource.uri === "workspace://package-json")).toBe(true);
    expect(resources.some((resource) => resource.uri === "workspace://progress-log")).toBe(true);
    expect(tools.map((tool) => tool.name)).toEqual(["search-files", "read-snippet"]);
  });

  it("reads workspace resources and runs local MCP tools", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-mcp-"));
    tempDirs.push(workspace);
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "codeclaw" }), "utf8");
    await writeFile(path.join(workspace, "sample.ts"), "export const greetUser = true;\n", "utf8");

    const packageJson = await readMcpResource(workspace, "workspace-mcp", "workspace://package-json");
    const searchOutput = await callMcpTool(workspace, "workspace-mcp", "search-files", "sample");
    const snippetOutput = await callMcpTool(workspace, "workspace-mcp", "read-snippet", "sample.ts");

    expect(packageJson).toContain("\"name\":\"codeclaw\"");
    expect(searchOutput).toContain("- sample.ts");
    expect(snippetOutput).toContain("path: sample.ts");
    expect(snippetOutput).toContain("export const greetUser = true;");
  });
});

