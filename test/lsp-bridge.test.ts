import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const workspaceRoot = "/Users/xutianliang/Downloads/codeclaw";
const bridgeScript = path.join(workspaceRoot, "scripts", "lsp_multilspy_bridge.py");
const venvPython = path.join(workspaceRoot, ".venv-lsp", "bin", "python");
const canRunRealBridge = existsSync(bridgeScript) && existsSync(venvPython);

afterEach(async () => {
  await Promise.all(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function runBridge(
  workspace: string,
  kind: "symbol" | "definition" | "references",
  query: string
): Promise<{ degraded: boolean; items: Array<Record<string, unknown>> }> {
  const result = await execFileAsync(
    venvPython,
    [bridgeScript, "--kind", kind, "--workspace", workspace, "--query", query],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        CODECLAW_MULTILSPY_TIMEOUT_SECONDS: "30",
      },
      maxBuffer: 1024 * 1024,
    }
  );

  return JSON.parse(result.stdout.trim()) as { degraded: boolean; items: Array<Record<string, unknown>> };
}

describe("real multilspy bridge", () => {
  it.runIf(canRunRealBridge)("keeps multiple references on the same line", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-bridge-"));
    tempDirs.push(workspace);
    await writeFile(path.join(workspace, "package.json"), '{"name":"bridge","version":"1.0.0"}', "utf8");
    await writeFile(
      path.join(workspace, "tsconfig.json"),
      '{"compilerOptions":{"target":"ES2020","module":"ESNext"},"include":["**/*.ts"]}',
      "utf8"
    );
    await writeFile(
      path.join(workspace, "sample.ts"),
      [
        "export function greetUser(name: string) {",
        "  return name;",
        "}",
        "const x = greetUser(\"a\") + greetUser(\"b\");"
      ].join("\n"),
      "utf8"
    );

    const result = await runBridge(workspace, "references", "greetUser");

    expect(result.degraded).toBe(false);
    expect(result.items).toHaveLength(3);
    expect(result.items.filter((item) => item.relation === "reference" && item.line === 4)).toHaveLength(2);
  }, 15_000);

  it.runIf(canRunRealBridge)("prefers the anchor language in a mixed-language workspace", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-bridge-"));
    tempDirs.push(workspace);
    await writeFile(path.join(workspace, "package.json"), '{"name":"bridge","version":"1.0.0"}', "utf8");
    await writeFile(
      path.join(workspace, "tsconfig.json"),
      '{"compilerOptions":{"target":"ES2020","module":"ESNext"},"include":["**/*.ts"]}',
      "utf8"
    );
    await writeFile(
      path.join(workspace, "sample.ts"),
      "export function greetUser(name: string) {\n  return name;\n}\n",
      "utf8"
    );
    await writeFile(path.join(workspace, "py_a.py"), "def helper_a():\n    return 1\n", "utf8");
    await writeFile(path.join(workspace, "py_b.py"), "def helper_b():\n    return 1\n", "utf8");
    await writeFile(path.join(workspace, "py_c.py"), "def helper_c():\n    return 1\n", "utf8");

    const result = await runBridge(workspace, "definition", "greetUser");

    expect(result.degraded).toBe(false);
    expect(result.items[0]?.file).toBe("sample.ts");
  }, 15_000);
});
