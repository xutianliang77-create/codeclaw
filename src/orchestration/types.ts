import type { PermissionMode } from "../lib/config";
import type { ProviderStatus } from "../provider/types";

export type IntentType = "task" | "query" | "create" | "fix" | "analyze";

export interface Intent {
  type: IntentType;
  entities: {
    files: string[];
    functions: string[];
    modules: string[];
  };
  constraints: {
    timeLimit?: number;
    budgetLimit?: number;
    qualityThreshold?: number;
  };
  confidence: number;
}

export type CompletionCheck =
  | {
      id: string;
      type: "path-exists";
      description: string;
      path: string;
    }
  | {
      id: string;
      type: "workspace-has-source-files";
      description: string;
    }
  | {
      id: string;
      type: "provider-available";
      description: string;
    }
  | {
      id: string;
      type: "tool-available";
      description: string;
      toolName: "read" | "glob" | "symbol" | "definition" | "references" | "bash" | "write" | "append" | "replace";
    }
  | {
      id: string;
      type: "package-script-present";
      description: string;
      scriptName: string;
    }
  | {
      id: string;
      type: "permission-mode";
      description: string;
      allowedModes: PermissionMode[];
    };

export interface GoalDefinition {
  id: string;
  description: string;
  deps: string[];
  budget: { tokens: number; cost: number; time: number };
  priority: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  completionChecks: CompletionCheck[];
  actions: ExecutionAction[];
}

export type ExecutionAction =
  | {
      id: string;
      type: "inspect-file";
      path: string;
    }
  | {
      id: string;
      type: "inspect-symbol";
      symbol: string;
    }
  | {
      id: string;
      type: "inspect-references";
      symbol: string;
    }
  | {
      id: string;
      type: "inspect-pattern";
      pattern: string;
    }
  | {
      id: string;
      type: "run-package-script";
      scriptName: "typecheck";
    }
  | {
      id: string;
      type: "request-write-approval";
      operation: "write" | "append" | "replace";
      target: string;
      reason: string;
    };

export interface OrchestrationApprovalRequest {
  id: string;
  actionId: string;
  operation: "write" | "append" | "replace";
  target: string;
  reason: string;
  status: "pending" | "approved" | "denied" | "timed_out";
}

export interface Strategy {
  type: "dag-planning" | "direct-response" | "scaffolding" | "diagnostic" | "analysis";
  detail: string;
}

export interface OrchestrationPlan {
  intent: Intent;
  strategy: Strategy;
  userGoal: string;
  goals: GoalDefinition[];
}

export interface OrchestrationContext {
  workspace: string;
  currentProvider: ProviderStatus | null;
  permissionMode: PermissionMode;
}

export interface CheckObservation {
  goalId: string;
  checkId: string;
  passed: boolean;
  detail: string;
}

export interface ExecutedGoal {
  goal: GoalDefinition;
  observations: CheckObservation[];
}

export interface Gap {
  id: string;
  goalId: string;
  checkId?: string;
  severity: "low" | "medium" | "high";
  description: string;
  rootCause: string;
  suggestedFix: string;
}

export interface ExecutionResult {
  completed: ExecutedGoal[];
  failed: ExecutedGoal[];
  gaps: Gap[];
  observations: CheckObservation[];
  actionLogs: string[];
  approvalRequests: OrchestrationApprovalRequest[];
  cost: {
    checksRun: number;
  };
  duration: number;
}

export interface ReflectorResult {
  gaps: Gap[];
  newGoals: GoalDefinition[];
  isComplete: boolean;
  decision: "complete" | "replan" | "escalated" | "approval-required";
}
