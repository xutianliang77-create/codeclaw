import { loadEditableConfig, resolveConfigPaths } from "../lib/config";

export async function loadSetupCommandState(): Promise<{
  config: Awaited<ReturnType<typeof loadEditableConfig>>["config"];
  providers: Awaited<ReturnType<typeof loadEditableConfig>>["providers"];
  paths: ReturnType<typeof resolveConfigPaths>;
}> {
  const paths = resolveConfigPaths();
  const editable = await loadEditableConfig(paths);

  return {
    ...editable,
    paths
  };
}
