import type { Intent, IntentType } from "./types";

const FILE_PATTERN = /(?:\.{1,2}\/|\/)?[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+/g;
const FUNCTION_PATTERN = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function detectIntentType(goal: string): IntentType {
  const normalized = goal.toLowerCase();

  if (/\b(fix|bug|broken|error|repair|debug)\b/.test(normalized)) {
    return "fix";
  }

  if (/\b(create|build|implement|add|generate|scaffold)\b/.test(normalized)) {
    return "create";
  }

  if (/\b(analyze|review|understand|inspect|explain|evaluate)\b/.test(normalized)) {
    return "analyze";
  }

  if (normalized.includes("?") || /\b(what|why|how|which|where)\b/.test(normalized)) {
    return "query";
  }

  return "task";
}

export function parseIntent(goal: string): Intent {
  const files = unique((goal.match(FILE_PATTERN) ?? []).map((match) => match.replace(/[),.:;]+$/, "")));
  const words = unique(goal.match(FUNCTION_PATTERN) ?? []);
  const functions = words.filter((word) => /[a-z][A-Z]|[A-Z][a-z]+/.test(word)).slice(0, 5);
  const modules = files.map((file) => file.split("/")[0]).filter(Boolean).slice(0, 5);
  const type = detectIntentType(goal);
  const confidence = files.length > 0 || functions.length > 0 ? 0.82 : 0.64;

  return {
    type,
    entities: {
      files,
      functions,
      modules
    },
    constraints: {},
    confidence
  };
}
