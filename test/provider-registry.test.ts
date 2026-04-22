import { describe, expect, it, vi } from "vitest";
import { createDefaultConfig, createDefaultProvidersFile } from "../src/lib/config";
import { ProviderRegistry } from "../src/provider/registry";

describe("provider registry", () => {
  it("marks cloud providers unavailable when API keys are missing", async () => {
    delete process.env.CODECLAW_ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const registry = await ProviderRegistry.create({
      providersFile: createDefaultProvidersFile(),
      fetchImpl: vi.fn<typeof fetch>()
    });

    const anthropic = registry.get("anthropic");

    expect(anthropic.configured).toBe(false);
    expect(anthropic.available).toBe(false);
    expect(anthropic.reason).toContain("missing API key");
  });

  it("selects the configured default provider when available", async () => {
    process.env.CODECLAW_OPENAI_API_KEY = "test-openai-key";
    const config = createDefaultConfig("/tmp/codeclaw");
    config.provider.default = "openai";
    config.provider.fallback = "anthropic";

    const registry = await ProviderRegistry.create({
      providersFile: createDefaultProvidersFile(),
      fetchImpl: vi.fn<typeof fetch>()
    });
    const selection = registry.select(config);

    expect(selection.current?.type).toBe("openai");
    expect(selection.current?.available).toBe(true);
  });

  it("probes local providers through fetch", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true
    } as Response);

    const registry = await ProviderRegistry.create({
      providersFile: {
        ...createDefaultProvidersFile(),
        ollama: {
          enabled: true,
          baseUrl: "http://127.0.0.1:11434",
          model: "llama3.1",
          timeoutMs: 50
        }
      },
      fetchImpl: mockFetch
    });

    const ollama = registry.get("ollama");

    expect(ollama.configured).toBe(true);
    expect(ollama.available).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  });
});
