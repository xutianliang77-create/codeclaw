import type { ExecutionResult, Gap, GoalDefinition, OrchestrationApprovalRequest, ReflectorResult } from "./types";

export function buildGapSignature(gaps: Gap[]): string {
  return gaps
    .map((gap) => `${gap.rootCause}:${gap.suggestedFix}:${gap.severity}`)
    .sort()
    .join("|");
}

function buildReplanGoals(gaps: Gap[]): GoalDefinition[] {
  return gaps.slice(0, 3).map((gap, index) => ({
    id: `replan-${index + 1}`,
    description: `Resolve gap: ${gap.description}`,
    deps: [],
    budget: { tokens: 600, cost: 0, time: 6_000 },
    priority: 1,
    riskLevel: gap.severity === "high" ? "high" : "medium",
    actions: [],
    completionChecks: [
      {
        id: `recheck-${index + 1}`,
        type: "tool-available",
        description: "inspection tooling available for gap follow-up",
        toolName: "read"
      }
    ]
  }));
}

function buildApprovalFollowUpGoals(request: OrchestrationApprovalRequest): GoalDefinition[] {
  return [
    {
      id: `approval-follow-up-${request.id}`,
      description: `Execute approved ${request.operation} flow for ${request.target}`,
      deps: [],
      budget: { tokens: 800, cost: 0, time: 8_000 },
      priority: 1,
      riskLevel: "high",
      actions: [],
      completionChecks: [
        {
          id: `approval-follow-up-check-${request.id}`,
          type: "tool-available",
          description: "write tooling available for approved follow-up",
          toolName: request.operation === "replace" ? "replace" : request.operation
        }
      ]
    }
  ];
}

export function reflectOnExecution(
  expectedGoals: GoalDefinition[],
  actualResults: ExecutionResult,
  recentGapSignatures: string[] = []
): ReflectorResult {
  if (actualResults.approvalRequests.some((request) => request.status === "pending")) {
    return {
      gaps: actualResults.gaps,
      newGoals: [],
      isComplete: false,
      decision: "approval-required"
    };
  }

  if (actualResults.failed.length === 0 && actualResults.gaps.length === 0) {
    return {
      gaps: [],
      newGoals: [],
      isComplete: true,
      decision: "complete"
    };
  }

  const signature = buildGapSignature(actualResults.gaps);
  const repeatedFailures = recentGapSignatures.filter((item) => item === signature).length;
  if (signature && repeatedFailures >= 1) {
    return {
      gaps: actualResults.gaps,
      newGoals: [],
      isComplete: false,
      decision: "escalated"
    };
  }

  const remainingGoalIds = new Set(actualResults.failed.map((goal) => goal.goal.id));
  const missingGoals = expectedGoals.filter((goal) => remainingGoalIds.has(goal.id));
  const newGoals = buildReplanGoals(actualResults.gaps.length > 0 ? actualResults.gaps : missingGoals.map((goal) => ({
    id: `gap-${goal.id}`,
    goalId: goal.id,
    severity: "medium",
    description: goal.description,
    rootCause: "goal not completed",
    suggestedFix: "re-run with explicit checks"
  })));

  return {
    gaps: actualResults.gaps,
    newGoals,
    isComplete: false,
    decision: "replan"
  };
}

export function reflectOnApprovalOutcome(
  request: OrchestrationApprovalRequest,
  outcome: "approved" | "denied" | "timed_out"
): ReflectorResult {
  if (outcome === "approved") {
    return {
      gaps: [],
      newGoals: buildApprovalFollowUpGoals({
        ...request,
        status: "approved"
      }),
      isComplete: false,
      decision: "replan"
    };
  }

  const reason = outcome === "denied" ? "approval denied by user" : "approval timed out";
  return {
    gaps: [
      {
        id: `approval-gap-${request.id}`,
        goalId: request.id,
        severity: "high",
        description: `${request.operation} ${request.target} blocked`,
        rootCause: reason,
        suggestedFix: "revise the plan or request approval again with narrower scope"
      }
    ],
    newGoals: [],
    isComplete: false,
    decision: "escalated"
  };
}
