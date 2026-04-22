import { readConfig, resolveConfigPaths } from "../lib/config";
import { ProviderRegistry } from "../provider/registry";
import { VERSION } from "../version";

export async function runDoctor(): Promise<string> {
  const paths = resolveConfigPaths();
  const config = await readConfig(paths);
  const registry = await ProviderRegistry.create({ paths });
  const providers = registry.list();
  const lines = [
    `CodeClaw ${VERSION}`,
    `node: ${process.version}`,
    `bun: ${process.versions.bun ?? "not available"}`,
    `platform: ${process.platform}`,
    `cwd: ${process.cwd()}`,
    `config: ${paths.configFile}`,
    `providers-file: ${paths.providersFile}`,
    `default-provider: ${config?.provider.default ?? "not configured"}`,
    `fallback-provider: ${config?.provider.fallback ?? "not configured"}`,
    "",
    "providers:"
  ];

  for (const provider of providers) {
    lines.push(
      `- ${provider.type} (${provider.displayName})`,
      `  configured: ${provider.configured}`,
      `  available: ${provider.available}`,
      `  model: ${provider.model}`,
      `  baseUrl: ${provider.baseUrl}`,
      `  reason: ${provider.reason}`
    );
  }

  return lines.join("\n");
}
