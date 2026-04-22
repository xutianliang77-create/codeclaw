import type {
  OrchestrationPlan,
  OrchestrationContext,
  Strategy,
  GoalDefinition,
  CompletionCheck,
  ExecutionAction
} from "./types";
import { parseIntent } from "./intentParser";

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function estimateRisk(type: OrchestrationPlan["intent"]["type"]): GoalDefinition["riskLevel"] {
  switch (type) {
    case "fix":
      return "medium";
    case "create":
      return "high";
    case "analyze":
    case "query":
      return "low";
    default:
      return "medium";
  }
}

function buildStrategy(type: OrchestrationPlan["intent"]["type"]): Strategy {
  switch (type) {
    case "query":
      return { type: "direct-response", detail: "answer-focused with explicit checks" };
    case "analyze":
      return { type: "analysis", detail: "inspect-first orchestration" };
    case "create":
      return { type: "scaffolding", detail: "write-capable plan with validation checks" };
    case "fix":
      return { type: "diagnostic", detail: "diagnose, patch, validate" };
    default:
      return { type: "dag-planning", detail: "small sequential plan with explicit completion checks" };
  }
}

function createScopeChecks(files: string[]): CompletionCheck[] {
  if (files.length > 0) {
    return files.slice(0, 5).map((file) => ({
      id: createId("check"),
      type: "path-exists" as const,
      description: `target path exists: ${file}`,
      path: file
    }));
  }

  return [
    {
      id: createId("check"),
      type: "workspace-has-source-files",
      description: "workspace contains source files"
    }
  ];
}

function createExecutionChecks(type: OrchestrationPlan["intent"]["type"]): CompletionCheck[] {
  const checks: CompletionCheck[] = [
    {
      id: createId("check"),
      type: "tool-available",
      description: "read tool available",
      toolName: "read"
    },
    {
      id: createId("check"),
      type: "tool-available",
      description: "glob tool available",
      toolName: "glob"
    }
  ];

  if (type === "query" || type === "analyze") {
    checks.push({
      id: createId("check"),
      type: "tool-available",
      description: "symbol navigation tools available",
      toolName: "definition"
    });
  }

  if (type === "create" || type === "fix" || type === "task") {
    checks.push({
      id: createId("check"),
      type: "provider-available",
      description: "provider available for orchestration"
    });
    checks.push({
      id: createId("check"),
      type: "permission-mode",
      description: "permission mode supports edits or approvals",
      allowedModes: ["plan", "auto", "acceptEdits", "bypassPermissions", "dontAsk"]
    });
  }

  return checks;
}

function createScopeActions(files: string[]): ExecutionAction[] {
  const actions: ExecutionAction[] = files.slice(0, 3).map((file) => ({
    id: createId("action"),
    type: "inspect-file",
    path: file
  }));
  const siblingPatterns = unique(
    files
      .slice(0, 3)
      .map((file) => file.replace(/\\/g, "/"))
      .map((file) => {
        const parts = file.split("/");
        parts.pop();
        return parts.length > 0 ? `${parts.join("/")}/*.ts` : "";
      })
      .filter(Boolean)
  );

  for (const pattern of siblingPatterns.slice(0, 2)) {
    actions.push({
      id: createId("action"),
      type: "inspect-pattern",
      pattern
    });
  }

  return actions;
}

function createExecutionActions(intent: OrchestrationPlan["intent"]): ExecutionAction[] {
  const actions: ExecutionAction[] = [];

  for (const functionName of intent.entities.functions.slice(0, 2)) {
    actions.push({
      id: createId("action"),
      type: "inspect-symbol",
      symbol: functionName
    });
    actions.push({
      id: createId("action"),
      type: "inspect-references",
      symbol: functionName
    });
  }

  if (intent.entities.files.length > 0) {
    const nearbyPatterns = unique(
      intent.entities.files
        .slice(0, 2)
        .map((file) => file.replace(/\\/g, "/"))
        .map((file) => {
          const parts = file.split("/");
          parts.pop();
          return parts.length > 0 ? `${parts.join("/")}/*.ts` : "";
        })
        .filter(Boolean)
    );

    for (const pattern of nearbyPatterns) {
      actions.push({
        id: createId("action"),
        type: "inspect-pattern",
        pattern
      });
    }
  }

  if (actions.length === 0 && intent.entities.files.length === 0 && (intent.type === "analyze" || intent.type === "query")) {
    actions.push({
      id: createId("action"),
      type: "inspect-pattern",
      pattern: "src/**/*.ts"
    });
  }

  return actions;
}

function createValidationChecks(type: OrchestrationPlan["intent"]["type"]): CompletionCheck[] {
  if (type === "create" || type === "fix") {
    return [
      {
        id: createId("check"),
        type: "package-script-present",
        description: "typecheck script available for validation",
        scriptName: "typecheck"
      }
    ];
  }

  return [
    {
      id: createId("check"),
      type: "tool-available",
      description: "references tool available for impact validation",
      toolName: "references"
    }
  ];
}

function createValidationActions(type: OrchestrationPlan["intent"]["type"]): ExecutionAction[] {
  if (type === "create" || type === "fix") {
    return [
      {
        id: createId("action"),
        type: "run-package-script",
        scriptName: "typecheck"
      }
    ];
  }

  return [];
}

function createWriteApprovalActions(intent: OrchestrationPlan["intent"]): ExecutionAction[] {
  if ((intent.type !== "create" && intent.type !== "fix" && intent.type !== "task") || intent.entities.files.length === 0) {
    return [];
  }

  return intent.entities.files.slice(0, 2).map((file) => ({
    id: createId("action"),
    type: "request-write-approval",
    operation: intent.type === "fix" ? "replace" : "write",
    target: file,
    reason: `${intent.type} flow may need to modify ${file}`
  }));
}

export function buildOrchestrationPlan(userGoal: string, context: OrchestrationContext): OrchestrationPlan {
  void context;
  const intent = parseIntent(userGoal);
  const strategy = buildStrategy(intent.type);
  const riskLevel = estimateRisk(intent.type);
  const goals: GoalDefinition[] = [
    {
      id: createId("goal"),
      description: "Confirm scope and target availability",
      deps: [],
      budget: { tokens: 500, cost: 0, time: 5_000 },
      priority: 3,
      riskLevel: "low",
      completionChecks: createScopeChecks(intent.entities.files),
      actions: createScopeActions(intent.entities.files)
    },
    {
      id: createId("goal"),
      description: `Prepare execution lane for ${intent.type}`,
      deps: [],
      budget: { tokens: 1_000, cost: 0, time: 10_000 },
      priority: 2,
      riskLevel,
      completionChecks: createExecutionChecks(intent.type),
      actions: [...createExecutionActions(intent), ...createWriteApprovalActions(intent)]
    },
    {
      id: createId("goal"),
      description: "Confirm validation path before work is considered complete",
      deps: [],
      budget: { tokens: 800, cost: 0, time: 8_000 },
      priority: 1,
      riskLevel: typeNeedsValidationRisk(intent.type),
      completionChecks: createValidationChecks(intent.type),
      actions: createValidationActions(intent.type)
    }
  ];

  return {
    intent,
    strategy,
    userGoal,
    goals
  };
}

function typeNeedsValidationRisk(type: OrchestrationPlan["intent"]["type"]): GoalDefinition["riskLevel"] {
  return type === "create" || type === "fix" ? "high" : "medium";
}
