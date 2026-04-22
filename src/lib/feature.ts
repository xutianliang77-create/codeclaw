export function feature(name: string): boolean {
  const envValue = process.env[`CODECLAW_FEATURE_${name}`];
  if (envValue === "1" || envValue === "true") {
    return true;
  }

  if (envValue === "0" || envValue === "false") {
    return false;
  }

  const defaults: Record<string, boolean> = {
    TOKEN_BUDGET: true
  };

  return defaults[name] ?? false;
}
