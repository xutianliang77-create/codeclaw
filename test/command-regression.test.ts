import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfigCommandState } from "../src/commands/config";
import { runDoctor } from "../src/commands/doctor";
import { loadSetupCommandState } from "../src/commands/setup";
import { createDefaultConfig, createDefaultProvidersFile, resolveConfigPaths, writeConfig, writeProvidersFile } from "../src/lib/config";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

beforeEach(async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codeclaw-home-"));
  tempDirs.push(homeDir);
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  await Promise.all(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("command regression", () => {
  it("loads default setup state from an empty home directory", async () => {
    const state = await loadSetupCommandState();

    expect(state.config.defaults.permissionMode).toBe("plan");
    expect(state.providers["openai:default"]?.enabled).toBe(true);
    expect(state.paths.configFile).toContain(".codeclaw/config.yaml");
  });

  it("loads saved config state for the config command", async () => {
    const paths = resolveConfigPaths();
    const config = createDefaultConfig("/tmp/custom-workspace");
    config.defaults.permissionMode = "acceptEdits";
    config.provider.default = "openai:default";
    const providers = createDefaultProvidersFile();
    providers["openai:default"] = {
      ...providers["openai:default"],
      model: "gpt-4.1"
    };
    await writeConfig(config, paths);
    await writeProvidersFile(providers, paths);

    const state = await loadConfigCommandState();

    expect(state.config.defaults.permissionMode).toBe("acceptEdits");
    expect(state.config.provider.default).toBe("openai:default");
    expect(state.providers["openai:default"]?.model).toBe("gpt-4.1");
  });

  it("reports provider diagnostics through doctor", async () => {
    const paths = resolveConfigPaths();
    await writeConfig(createDefaultConfig(), paths);
    await writeProvidersFile(createDefaultProvidersFile(), paths);

    const output = await runDoctor();

    expect(output).toContain("CodeClaw 0.8.1");
    expect(output).toContain("default-provider:");
    expect(output).toContain("providers:");
    expect(output).toContain("openai:default");
    expect(output).toContain("type=openai");
  });
});
