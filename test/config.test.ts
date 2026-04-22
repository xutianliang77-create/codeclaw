import { describe, expect, it } from "vitest";
import { createDefaultConfig, resolveConfigPaths } from "../src/lib/config";

describe("config helpers", () => {
  it("creates a stable default config", () => {
    const config = createDefaultConfig("/tmp/codeclaw");

    expect(config.provider.default).toBe("anthropic");
    expect(config.provider.fallback).toBe("openai");
    expect(config.defaults.workspace).toBe("/tmp/codeclaw");
    expect(config.defaults.permissionMode).toBe("plan");
  });

  it("resolves config paths under the home directory", () => {
    const paths = resolveConfigPaths("/Users/tester");

    expect(paths.configDir).toBe("/Users/tester/.codeclaw");
    expect(paths.configFile).toBe("/Users/tester/.codeclaw/config.yaml");
    expect(paths.sessionsDir).toBe("/Users/tester/.codeclaw/sessions");
  });
});
