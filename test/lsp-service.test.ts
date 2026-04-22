import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessLspBackend, clearLspBackendAssessmentCache } from "../src/lsp/backend";
import {
  clearWorkspaceIndexCache,
  getWorkspaceIndexState,
  invalidateWorkspaceIndex,
  queryDefinitions,
  queryReferences,
  querySymbols
} from "../src/lsp/service";

const tempDirs: string[] = [];

afterEach(async () => {
  clearWorkspaceIndexCache();
  clearLspBackendAssessmentCache();
  delete process.env.CODECLAW_ENABLE_REAL_LSP;
  delete process.env.CODECLAW_PYTHON;
  delete process.env.CODECLAW_LSP_BRIDGE_SCRIPT;
  await Promise.all(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("lsp service", () => {
  it("indexes symbols and returns degraded fallback results", async () => {
    process.env.CODECLAW_ENABLE_REAL_LSP = "0";
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-lsp-"));
    tempDirs.push(workspace);
    await writeFile(
      path.join(workspace, "sample.ts"),
      [
        "export function greetUser(name: string) {",
        "  return name;",
        "}",
        "",
        "const localValue = greetUser(\"hi\");"
      ].join("\n"),
      "utf8"
    );

    const symbols = await querySymbols(workspace, "greetUser");
    const definition = await queryDefinitions(workspace, "greetUser");
    const references = await queryReferences(workspace, "greetUser");

    expect(symbols.backend).toBe("fallback-regex-index");
    expect(symbols.degraded).toBe(true);
    expect(symbols.items[0]?.name).toBe("greetUser");
    expect(definition.items[0]?.file).toBe("sample.ts");
    expect(references.items.length).toBeGreaterThanOrEqual(2);
  });

  it("refreshes the workspace symbol index after file changes", async () => {
    process.env.CODECLAW_ENABLE_REAL_LSP = "0";
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-lsp-"));
    tempDirs.push(workspace);
    const file = path.join(workspace, "sample.ts");
    await writeFile(file, "export function greetUser(name: string) {\n  return name;\n}\n", "utf8");

    const firstState = await getWorkspaceIndexState(workspace);
    expect(firstState.symbolCount).toBeGreaterThanOrEqual(1);

    await writeFile(
      file,
      [
        "export function greetUser(name: string) {",
        "  return name;",
        "}",
        "",
        "export function greetAdmin(name: string) {",
        "  return greetUser(name);",
        "}"
      ].join("\n"),
      "utf8"
    );
    invalidateWorkspaceIndex(workspace, "sample.ts");

    const refreshed = await querySymbols(workspace, "greetAdmin");
    const refreshedState = await getWorkspaceIndexState(workspace);

    expect(refreshed.items[0]?.name).toBe("greetAdmin");
    expect(refreshedState.symbolCount).toBeGreaterThan(firstState.symbolCount);
  });

  it("supports additional language patterns and prefers definitions", async () => {
    process.env.CODECLAW_ENABLE_REAL_LSP = "0";
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-lsp-"));
    tempDirs.push(workspace);
    await writeFile(
      path.join(workspace, "service.py"),
      ["class UserService:", "    def load_user(self, user_id):", "        return user_id"].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "feature.kt"),
      ["data class UserProfile(val id: String)", "fun loadUserProfile(id: String) = UserProfile(id)"].join("\n"),
      "utf8"
    );

    const symbols = await querySymbols(workspace, "load");
    const definition = await queryDefinitions(workspace, "loadUserProfile");

    expect(symbols.items.some((item) => item.kind === "python" && item.name === "load_user")).toBe(true);
    expect(symbols.items.some((item) => item.kind === "kotlin" && item.name === "loadUserProfile")).toBe(true);
    expect(definition.items[0]?.name).toBe("loadUserProfile");
  });

  it("skips virtualenv directories when building the workspace index", async () => {
    process.env.CODECLAW_ENABLE_REAL_LSP = "0";
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-lsp-"));
    tempDirs.push(workspace);
    await writeFile(
      path.join(workspace, "sample.ts"),
      "export function greetUser(name: string) {\n  return name;\n}\n",
      "utf8"
    );
    await mkdir(path.join(workspace, ".venv-lsp"), { recursive: true });
    await writeFile(
      path.join(workspace, ".venv-lsp", "lib.py"),
      "def hidden_python_symbol():\n    return True\n",
      "utf8"
    );

    const state = await getWorkspaceIndexState(workspace);
    const symbols = await querySymbols(workspace, "hidden_python_symbol");

    expect(state.sourceFileCount).toBe(1);
    expect(symbols.items).toHaveLength(0);
  });

  it("deduplicates references and puts the definition first", async () => {
    process.env.CODECLAW_ENABLE_REAL_LSP = "0";
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-lsp-"));
    tempDirs.push(workspace);
    await writeFile(
      path.join(workspace, "sample.ts"),
      [
        "export function greetUser(name: string) {",
        "  return name;",
        "}",
        "const again = greetUser(\"a\") + greetUser(\"b\");"
      ].join("\n"),
      "utf8"
    );

    const references = await queryReferences(workspace, "greetUser");

    expect(references.items[0]?.relation).toBe("definition");
    expect(references.items.filter((item) => item.file === "sample.ts" && item.line === 4)).toHaveLength(1);
  });

  it("reports real backend assessment while staying on fallback", async () => {
    process.env.CODECLAW_ENABLE_REAL_LSP = "0";
    const assessment = await assessLspBackend();

    expect(assessment.activeBackend).toBe("fallback-regex-index");
    expect(assessment.realBackendCandidate.name).toBe("multilspy");
    expect(assessment.realBackendCandidate.status).toBe("not_enabled");
  });

  it("auto-prefers the real backend bridge when multilspy is importable", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-lsp-"));
    tempDirs.push(workspace);
    const fakePython = path.join(workspace, "fake-python.sh");
    await writeFile(
      fakePython,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"-c\" ]; then",
        "  echo 1",
        "  exit 0",
        "fi",
        "kind=\"\"",
        "query=\"\"",
        "while [ \"$#\" -gt 0 ]; do",
        "  case \"$1\" in",
        "    --kind) kind=\"$2\"; shift 2 ;;",
        "    --query) query=\"$2\"; shift 2 ;;",
        "    *) shift ;;",
        "  esac",
        "done",
        "if [ \"$kind\" = \"definition\" ]; then",
        "  printf '{\"degraded\":false,\"items\":[{\"name\":\"%s\",\"kind\":\"function\",\"file\":\"bridge-definition.ts\",\"line\":17,\"column\":5,\"snippet\":\"export function %s() {}\"}]}' \"$query\" \"$query\"",
        "  exit 0",
        "fi",
        "if [ \"$kind\" = \"references\" ]; then",
        "  printf '%s\\n' '{\"degraded\":false,\"items\":[{\"relation\":\"definition\",\"file\":\"bridge.ts\",\"line\":7,\"column\":3,\"snippet\":\"export function greetUser() {}\"},{\"relation\":\"reference\",\"file\":\"usage.ts\",\"line\":12,\"column\":8,\"snippet\":\"greetUser()\"}]}'",
        "  exit 0",
        "fi",
        "printf '{\"degraded\":false,\"items\":[{\"name\":\"%s\",\"kind\":\"function\",\"file\":\"bridge.ts\",\"line\":7,\"column\":3,\"snippet\":\"export function %s() {}\"}]}' \"$query\" \"$query\"",
      ].join("\n"),
      "utf8"
    );
    await chmod(fakePython, 0o755);

    process.env.CODECLAW_PYTHON = fakePython;

    const symbols = await querySymbols(workspace, "greetUser");
    const definition = await queryDefinitions(workspace, "greetUser");
    const references = await queryReferences(workspace, "greetUser");

    expect(symbols.backend).toBe("multilspy");
    expect(symbols.degraded).toBe(false);
    expect(symbols.items[0]?.file).toBe("bridge.ts");
    expect(definition.items[0]?.file).toBe("bridge-definition.ts");
    expect(references.backend).toBe("multilspy");
    expect(references.degraded).toBe(false);
    expect(references.items[0]?.relation).toBe("definition");
  });

  it("falls back to the regex index when the real backend bridge fails", async () => {
    process.env.CODECLAW_ENABLE_REAL_LSP = "1";
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-lsp-"));
    tempDirs.push(workspace);
    await writeFile(
      path.join(workspace, "sample.ts"),
      [
        "export function greetUser(name: string) {",
        "  return name;",
        "}",
        "const again = greetUser(\"a\");"
      ].join("\n"),
      "utf8"
    );
    const fakePython = path.join(workspace, "fake-python.sh");
    await writeFile(
      fakePython,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"-c\" ]; then",
        "  echo 1",
        "  exit 0",
        "fi",
        "echo '{\"error\":{\"message\":\"bridge boom\"}}'",
      ].join("\n"),
      "utf8"
    );
    await chmod(fakePython, 0o755);

    process.env.CODECLAW_ENABLE_REAL_LSP = "1";
    process.env.CODECLAW_PYTHON = fakePython;

    const symbols = await querySymbols(workspace, "greetUser");
    const references = await queryReferences(workspace, "greetUser");

    expect(symbols.backend).toBe("fallback-regex-index");
    expect(symbols.degraded).toBe(true);
    expect(symbols.items[0]?.file).toBe("sample.ts");
    expect(references.backend).toBe("fallback-regex-index");
    expect(references.degraded).toBe(true);
    expect(references.items[0]?.file).toBe("sample.ts");
  });
});
