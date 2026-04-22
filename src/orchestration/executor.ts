import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isHandledLocalToolResult, runLocalTool } from "../tools/local";
import type {
  CompletionCheck,
  ExecutionAction,
  ExecutionResult,
  ExecutedGoal,
  Gap,
  OrchestrationApprovalRequest,
  OrchestrationContext,
  OrchestrationPlan,
  CheckObservation
} from "./types";

const execFileAsync = promisify(execFile);
const MAX_ACTION_DETAIL_LENGTH = 240;

const SOURCE_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".kt",
  ".kts",
  ".rb",
  ".php",
  ".swift",
  ".cs",
  ".go",
  ".rs",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp"
]);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "coverage",
  ".venv",
  ".venv-lsp",
  "__pycache__"
]);
const AVAILABLE_TOOLS = new Set([
  "read",
  "glob",
  "symbol",
  "definition",
  "references",
  "bash",
  "write",
  "append",
  "replace"
]);

async function hasSourceFiles(currentDir: string): Promise<boolean> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (await hasSourceFiles(absolutePath)) {
        return true;
      }
      continue;
    }

    if (entry.isFile() && SOURCE_FILE_EXTENSIONS.has(path.extname(entry.name))) {
      return true;
    }
  }

  return false;
}

async function evaluateCheck(check: CompletionCheck, context: OrchestrationContext, goalId: string): Promise<CheckObservation> {
  switch (check.type) {
    case "path-exists":
      try {
        await access(path.resolve(context.workspace, check.path));
        return { goalId, checkId: check.id, passed: true, detail: `found ${check.path}` };
      } catch {
        return { goalId, checkId: check.id, passed: false, detail: `missing ${check.path}` };
      }
    case "workspace-has-source-files":
      {
        const passed = await hasSourceFiles(context.workspace);
        return {
          goalId,
          checkId: check.id,
          passed,
          detail: passed ? "workspace has source files" : "no source files found"
        };
      }
    case "provider-available":
      return {
        goalId,
        checkId: check.id,
        passed: context.currentProvider?.available === true,
        detail:
          context.currentProvider?.available === true
            ? `provider ${context.currentProvider.displayName} ready`
            : "provider not configured or unavailable"
      };
    case "tool-available":
      return {
        goalId,
        checkId: check.id,
        passed: AVAILABLE_TOOLS.has(check.toolName),
        detail: AVAILABLE_TOOLS.has(check.toolName) ? `${check.toolName} available` : `${check.toolName} unavailable`
      };
    case "package-script-present": {
      try {
        const packageJsonPath = path.join(context.workspace, "package.json");
        const content = await readFile(packageJsonPath, "utf8");
        const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
        const passed = Boolean(parsed.scripts?.[check.scriptName]);
        return {
          goalId,
          checkId: check.id,
          passed,
          detail: passed ? `package.json script "${check.scriptName}" present` : `missing package.json script "${check.scriptName}"`
        };
      } catch {
        return {
          goalId,
          checkId: check.id,
          passed: false,
          detail: "package.json unavailable for validation"
        };
      }
    }
    case "permission-mode":
      return {
        goalId,
        checkId: check.id,
        passed: check.allowedModes.includes(context.permissionMode),
        detail: check.allowedModes.includes(context.permissionMode)
          ? `permission mode ${context.permissionMode} allowed`
          : `permission mode ${context.permissionMode} not in [${check.allowedModes.join(", ")}]`
      };
  }
}

function observationToGap(observation: CheckObservation): Gap {
  return {
    id: `gap-${observation.checkId}`,
    goalId: observation.goalId,
    checkId: observation.checkId,
    severity: "medium",
    description: observation.detail,
    rootCause: observation.detail,
    suggestedFix: "address the failed completion check before continuing"
  };
}

function clipDetail(detail: string): string {
  return detail.length > MAX_ACTION_DETAIL_LENGTH ? `${detail.slice(0, MAX_ACTION_DETAIL_LENGTH - 3)}...` : detail;
}

async function executeAction(
  action: ExecutionAction,
  context: OrchestrationContext,
  goalId: string
): Promise<{ observation: CheckObservation; log: string; approvalRequest?: OrchestrationApprovalRequest }> {
  switch (action.type) {
    case "inspect-file": {
      const result = await runLocalTool(`/read ${action.path}`, context.workspace);
      if (!isHandledLocalToolResult(result)) {
        return {
          observation: {
            goalId,
            checkId: action.id,
            passed: false,
            detail: `action inspect-file failed for ${action.path}`
          },
          log: `inspect-file ${action.path}: handler unavailable`
        };
      }

      const detail = clipDetail(result.output.replace(/\s+/g, " ").trim());
      return {
        observation: {
          goalId,
          checkId: action.id,
          passed: result.status !== "failed",
          detail: `inspected file ${action.path}`
        },
        log: `inspect-file ${action.path}: ${detail}`
      };
    }
    case "inspect-symbol": {
      const result = await runLocalTool(`/definition ${action.symbol}`, context.workspace);
      if (!isHandledLocalToolResult(result)) {
        return {
          observation: {
            goalId,
            checkId: action.id,
            passed: false,
            detail: `action inspect-symbol failed for ${action.symbol}`
          },
          log: `inspect-symbol ${action.symbol}: handler unavailable`
        };
      }

      const passed = result.status !== "failed" && !result.output.includes("[not found]");
      return {
        observation: {
          goalId,
          checkId: action.id,
          passed,
          detail: passed ? `inspected symbol ${action.symbol}` : `symbol ${action.symbol} not found`
        },
        log: `inspect-symbol ${action.symbol}: ${clipDetail(result.output.replace(/\s+/g, " ").trim())}`
      };
    }
    case "inspect-references": {
      const result = await runLocalTool(`/references ${action.symbol}`, context.workspace);
      if (!isHandledLocalToolResult(result)) {
        return {
          observation: {
            goalId,
            checkId: action.id,
            passed: false,
            detail: `action inspect-references failed for ${action.symbol}`
          },
          log: `inspect-references ${action.symbol}: handler unavailable`
        };
      }

      const passed = result.status !== "failed" && !result.output.includes("[no matches]");
      return {
        observation: {
          goalId,
          checkId: action.id,
          passed,
          detail: passed ? `inspected references for ${action.symbol}` : `references for ${action.symbol} not found`
        },
        log: `inspect-references ${action.symbol}: ${clipDetail(result.output.replace(/\s+/g, " ").trim())}`
      };
    }
    case "inspect-pattern": {
      const result = await runLocalTool(`/glob ${action.pattern}`, context.workspace);
      if (!isHandledLocalToolResult(result)) {
        return {
          observation: {
            goalId,
            checkId: action.id,
            passed: false,
            detail: `action inspect-pattern failed for ${action.pattern}`
          },
          log: `inspect-pattern ${action.pattern}: handler unavailable`
        };
      }

      const passed = result.status !== "failed" && !result.output.includes("[no matches]");
      return {
        observation: {
          goalId,
          checkId: action.id,
          passed,
          detail: passed ? `inspected pattern ${action.pattern}` : `pattern ${action.pattern} had no matches`
        },
        log: `inspect-pattern ${action.pattern}: ${clipDetail(result.output.replace(/\s+/g, " ").trim())}`
      };
    }
    case "run-package-script": {
      try {
        const scriptResult = await execFileAsync("npm", ["run", action.scriptName], {
          cwd: context.workspace,
          timeout: 120_000,
          maxBuffer: 256 * 1024
        });
        const detail = clipDetail([scriptResult.stdout, scriptResult.stderr].filter(Boolean).join("\n").replace(/\s+/g, " ").trim() || "[no output]");
        return {
          observation: {
            goalId,
            checkId: action.id,
            passed: true,
            detail: `ran package script ${action.scriptName}`
          },
          log: `run-package-script ${action.scriptName}: ${detail}`
        };
      } catch (error) {
        const execError = error as Error & {
          stdout?: string;
          stderr?: string;
          code?: number | string;
          signal?: string;
        };
        const output = clipDetail(
          [execError.stdout, execError.stderr, execError.message].filter(Boolean).join("\n").replace(/\s+/g, " ").trim()
        );
        return {
          observation: {
            goalId,
            checkId: action.id,
            passed: false,
            detail: `package script ${action.scriptName} failed`
          },
          log: `run-package-script ${action.scriptName}: failed (${execError.code ?? execError.signal ?? "unknown"}) ${output}`
        };
      }
    }
    case "request-write-approval": {
      const approvalRequest: OrchestrationApprovalRequest = {
        id: `orchestration-approval-${action.id}`,
        actionId: action.id,
        operation: action.operation,
        target: action.target,
        reason: action.reason,
        status: "pending"
      };
      return {
        observation: {
          goalId,
          checkId: action.id,
          passed: false,
          detail: `write approval pending for ${action.operation} ${action.target}`
        },
        log: `request-write-approval ${action.operation} ${action.target}: pending`,
        approvalRequest
      };
    }
  }
}

export async function executeOrchestrationPlan(
  plan: OrchestrationPlan,
  context: OrchestrationContext
): Promise<ExecutionResult> {
  const startedAt = Date.now();
  const completed: ExecutedGoal[] = [];
  const failed: ExecutedGoal[] = [];
  const observations: CheckObservation[] = [];
  const gaps: Gap[] = [];
  const actionLogs: string[] = [];
  const approvalRequests: OrchestrationApprovalRequest[] = [];

  for (const goal of plan.goals) {
    const checkObservations = await Promise.all(
      goal.completionChecks.map((check) => evaluateCheck(check, context, goal.id))
    );
    observations.push(...checkObservations);
    const goalObservations = [...checkObservations];

    if (checkObservations.every((observation) => observation.passed) && goal.actions.length > 0) {
      const actionResults = await Promise.all(goal.actions.map((action) => executeAction(action, context, goal.id)));
      for (const actionResult of actionResults) {
        goalObservations.push(actionResult.observation);
        observations.push(actionResult.observation);
        actionLogs.push(actionResult.log);
        if (actionResult.approvalRequest) {
          approvalRequests.push(actionResult.approvalRequest);
        }
      }
    }

    const executedGoal: ExecutedGoal = {
      goal,
      observations: goalObservations
    };
    const goalFailed = goalObservations.some((observation) => !observation.passed);
    if (goalFailed) {
      failed.push(executedGoal);
      gaps.push(...goalObservations.filter((observation) => !observation.passed).map(observationToGap));
    } else {
      completed.push(executedGoal);
    }
  }

  return {
    completed,
    failed,
    gaps,
    observations,
    actionLogs,
    approvalRequests,
    cost: {
      checksRun: observations.length
    },
    duration: Date.now() - startedAt
  };
}
