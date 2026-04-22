import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionManager } from "../src/permissions/manager";
import { isHandledLocalToolResult, maybeRunLocalTool } from "../src/tools/local";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.CODECLAW_ENABLE_REAL_LSP;
  await Promise.all(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("local tools", () => {
  it("reads a file inside workspace", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-tools-"));
    tempDirs.push(workspace);
    const filePath = path.join(workspace, "notes.txt");
    await writeFile(filePath, "hello tools", "utf8");

    const result = await maybeRunLocalTool("/read notes.txt", {
      workspace,
      permissions: new PermissionManager("plan")
    });

    expect(result.handled).toBe(true);
    expect(isHandledLocalToolResult(result)).toBe(true);
    if (!isHandledLocalToolResult(result)) {
      throw new Error("expected handled result");
    }
    expect(result.kind).toBe("result");
    expect(result.output).toContain("hello tools");
  });

  it("requests approval for dangerous bash commands in plan mode", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-tools-"));
    tempDirs.push(workspace);

    const result = await maybeRunLocalTool("/bash rm -rf tmp", {
      workspace,
      permissions: new PermissionManager("plan")
    });

    expect(result.handled).toBe(true);
    expect(isHandledLocalToolResult(result)).toBe(true);
    if (!isHandledLocalToolResult(result)) {
      throw new Error("expected handled result");
    }
    expect(result.kind).toBe("error");
    expect(result.status).toBe("pending");
    if (result.kind !== "error") {
      throw new Error("expected error result");
    }
    expect(result.errorCode).toBe("approval_required");
    expect(result.output).toContain("Approval required");
  });

  it("runs low-risk bash commands", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-tools-"));
    tempDirs.push(workspace);

    const result = await maybeRunLocalTool("/bash pwd", {
      workspace,
      permissions: new PermissionManager("plan")
    });

    expect(result.handled).toBe(true);
    expect(isHandledLocalToolResult(result)).toBe(true);
    if (!isHandledLocalToolResult(result)) {
      throw new Error("expected handled result");
    }
    expect(result.kind).toBe("result");
    expect(result.output).toContain(workspace);
  });

  it("matches workspace files with glob", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-tools-"));
    tempDirs.push(workspace);
    await writeFile(path.join(workspace, "alpha.ts"), "export const alpha = true;\n", "utf8");
    await writeFile(path.join(workspace, "beta.md"), "# beta\n", "utf8");

    const result = await maybeRunLocalTool("/glob *.ts", {
      workspace,
      permissions: new PermissionManager("plan")
    });

    expect(result.handled).toBe(true);
    expect(isHandledLocalToolResult(result)).toBe(true);
    if (!isHandledLocalToolResult(result)) {
      throw new Error("expected handled result");
    }
    expect(result.kind).toBe("result");
    expect(result.output).toContain("alpha.ts");
    expect(result.output).not.toContain("beta.md");
  });

  it("skips virtualenv directories when collecting glob matches", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-tools-"));
    tempDirs.push(workspace);
    await mkdir(path.join(workspace, ".venv-lsp"), { recursive: true });
    await writeFile(path.join(workspace, ".venv-lsp", "hidden.ts"), "export const hidden = true;\n", "utf8");
    await writeFile(path.join(workspace, "visible.ts"), "export const visible = true;\n", "utf8");

    const result = await maybeRunLocalTool("/glob *.ts", {
      workspace,
      permissions: new PermissionManager("plan")
    });

    expect(result.handled).toBe(true);
    expect(isHandledLocalToolResult(result)).toBe(true);
    if (!isHandledLocalToolResult(result)) {
      throw new Error("expected handled result");
    }
    expect(result.kind).toBe("result");
    expect(result.output).toContain("visible.ts");
    expect(result.output).not.toContain("hidden.ts");
  });

  it("queries symbol definitions through degraded LSPTool fallback", async () => {
    process.env.CODECLAW_ENABLE_REAL_LSP = "0";
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-tools-"));
    tempDirs.push(workspace);
    await writeFile(
      path.join(workspace, "sample.ts"),
      "export function greetUser(name: string) {\n  return name;\n}\n",
      "utf8"
    );

    const result = await maybeRunLocalTool("/symbol greetUser", {
      workspace,
      permissions: new PermissionManager("plan")
    });

    expect(result.handled).toBe(true);
    expect(isHandledLocalToolResult(result)).toBe(true);
    if (!isHandledLocalToolResult(result)) {
      throw new Error("expected handled result");
    }
    expect(result.kind).toBe("result");
    expect(result.output).toContain("LSPTool backend: fallback-regex-index");
    expect(result.output).toContain("function greetUser");
  });

  it("writes a file in acceptEdits mode", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-tools-"));
    tempDirs.push(workspace);
    const filePath = path.join(workspace, "draft.txt");

    const result = await maybeRunLocalTool("/write draft.txt :: hello world", {
      workspace,
      permissions: new PermissionManager("acceptEdits")
    });

    expect(result.handled).toBe(true);
    expect(isHandledLocalToolResult(result)).toBe(true);
    if (!isHandledLocalToolResult(result)) {
      throw new Error("expected handled result");
    }
    expect(result.kind).toBe("result");
    expect(result.output).toContain("Wrote");
    const written = await readFile(filePath, "utf8");
    expect(written).toBe("hello world");
  });

  it("blocks write in plan mode", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-tools-"));
    tempDirs.push(workspace);

    const result = await maybeRunLocalTool("/write draft.txt :: hello world", {
      workspace,
      permissions: new PermissionManager("plan")
    });

    expect(result.handled).toBe(true);
    expect(isHandledLocalToolResult(result)).toBe(true);
    if (!isHandledLocalToolResult(result)) {
      throw new Error("expected handled result");
    }
    expect(result.kind).toBe("error");
    expect(result.status).toBe("pending");
    if (result.kind !== "error") {
      throw new Error("expected error result");
    }
    expect(result.errorCode).toBe("approval_required");
    expect(result.output).toContain("Approval required");
  });

  it("replaces text in acceptEdits mode", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-tools-"));
    tempDirs.push(workspace);
    const filePath = path.join(workspace, "draft.txt");
    await writeFile(filePath, "hello old world", "utf8");

    const result = await maybeRunLocalTool("/replace draft.txt :: old :: new", {
      workspace,
      permissions: new PermissionManager("acceptEdits")
    });

    expect(result.handled).toBe(true);
    expect(isHandledLocalToolResult(result)).toBe(true);
    if (!isHandledLocalToolResult(result)) {
      throw new Error("expected handled result");
    }
    expect(result.kind).toBe("result");
    expect(result.output).toContain("Replaced");
    const written = await readFile(filePath, "utf8");
    expect(written).toBe("hello new world");
  });
});
