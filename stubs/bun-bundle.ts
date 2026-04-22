export function feature(name: string): boolean {
  const features: Record<string, boolean> = {
    COORDINATOR_MODE: false,
    KAIROS: false,
    PROACTIVE: false,
    CONTEXT_COLLAPSE: false,
    REACTIVE_COMPACT: false,
    CACHED_MICROCOMPACT: false,
    HISTORY_SNIP: false,
    TOKEN_BUDGET: true,
    VOICE_MODE: false,
    FORK_SUBAGENT: false,
    CHICAGO_MCP: false,
    BG_SESSIONS: false,
    EXPERIMENTAL_SKILL_SEARCH: false,
    MONITOR_TOOL: false
  };

  return features[name] ?? false;
}
