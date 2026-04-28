import { describe, expect, it, vi } from "vitest";
import {
  createDefaultConfig,
  createDefaultProvidersFile,
  migrateConfigSelection,
  migrateProvidersFile
} from "../src/lib/config";
import { ProviderRegistry } from "../src/provider/registry";

describe("provider registry", () => {
  it("marks cloud providers unavailable when API keys are missing", async () => {
    delete process.env.CODECLAW_ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const registry = await ProviderRegistry.create({
      providersFile: createDefaultProvidersFile(),
      fetchImpl: vi.fn<typeof fetch>()
    });

    const anthropic = registry.get("anthropic:default");
    expect(anthropic).toBeDefined();
    expect(anthropic!.configured).toBe(false);
    expect(anthropic!.available).toBe(false);
    expect(anthropic!.reason).toContain("missing API key");
  });

  it("selects the configured default instance when available", async () => {
    process.env.CODECLAW_OPENAI_API_KEY = "test-openai-key";
    const config = createDefaultConfig("/tmp/codeclaw");
    config.provider.default = "openai:default";
    config.provider.fallback = "anthropic:default";

    const registry = await ProviderRegistry.create({
      providersFile: createDefaultProvidersFile(),
      fetchImpl: vi.fn<typeof fetch>()
    });
    const selection = registry.select(config);

    expect(selection.current?.type).toBe("openai");
    expect(selection.current?.instanceId).toBe("openai:default");
    expect(selection.current?.available).toBe(true);
  });

  it("probes local providers through fetch", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true
    } as Response);

    const registry = await ProviderRegistry.create({
      providersFile: {
        ...createDefaultProvidersFile(),
        "ollama:default": {
          type: "ollama",
          enabled: true,
          baseUrl: "http://127.0.0.1:11434",
          model: "llama3.1",
          timeoutMs: 50
        }
      },
      fetchImpl: mockFetch
    });

    const ollama = registry.get("ollama:default");
    expect(ollama).toBeDefined();
    expect(ollama!.configured).toBe(true);
    expect(ollama!.available).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  });

  it("supports multiple instances of the same provider type", async () => {
    process.env.CODECLAW_LMSTUDIO_API_KEY = "";
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue({ ok: true } as Response);

    const registry = await ProviderRegistry.create({
      providersFile: {
        "lmstudio:local": {
          type: "lmstudio",
          enabled: true,
          baseUrl: "http://127.0.0.1:1234/v1",
          model: "qwen-local",
          timeoutMs: 50
        },
        "lmstudio:remote": {
          type: "lmstudio",
          enabled: true,
          baseUrl: "http://10.0.0.1:1234/v1",
          model: "qwen-remote",
          timeoutMs: 50
        }
      },
      fetchImpl: mockFetch
    });

    expect(registry.get("lmstudio:local")?.model).toBe("qwen-local");
    expect(registry.get("lmstudio:remote")?.model).toBe("qwen-remote");
    expect(registry.list()).toHaveLength(2);
  });

  it("falls back to first available instance when default not configured", async () => {
    process.env.CODECLAW_OPENAI_API_KEY = "test-key";
    const mockFetch = vi.fn<typeof fetch>();
    const config = createDefaultConfig("/tmp/codeclaw");
    config.provider.default = "anthropic:default"; // no api key
    config.provider.fallback = "ollama:default"; // no probe ok

    const registry = await ProviderRegistry.create({
      providersFile: createDefaultProvidersFile(),
      fetchImpl: mockFetch
    });

    const selection = registry.select(config);
    // should fall through to firstAvailable (openai with api key)
    expect(selection.current?.type).toBe("openai");
  });

  it("migrates legacy providers.json (key=type) to instance form", () => {
    const legacy = {
      lmstudio: { enabled: true, baseUrl: "http://127.0.0.1:1234/v1", model: "x" }
    };
    const migrated = migrateProvidersFile(legacy);
    expect(migrated["lmstudio:default"]).toBeDefined();
    expect(migrated["lmstudio:default"].type).toBe("lmstudio");
    expect(migrated["lmstudio:default"].baseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("migrates legacy config.yaml provider.default (bare type → instanceId)", () => {
    const legacyMigrated = migrateProvidersFile({
      lmstudio: { enabled: true, baseUrl: "http://x", model: "y" }
    });
    const config = createDefaultConfig("/tmp/codeclaw");
    config.provider.default = "lmstudio";
    config.provider.fallback = "openai";
    const updated = migrateConfigSelection(config, legacyMigrated);
    expect(updated.provider.default).toBe("lmstudio:default");
    expect(updated.provider.fallback).toBe("openai");
  });
});
