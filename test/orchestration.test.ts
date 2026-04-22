import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildApprovedExecutionPlan,
  buildGapSignature,
  buildOrchestrationPlan,
  executeOrchestrationPlan,
  reflectOnApprovalOutcome,
  reflectOnExecution
} from "../src/orchestration";
import type { OrchestrationContext } from "../src/orchestration";
import type { ProviderStatus } from "../src/provider/types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

const provider: ProviderStatus = {
  type: "openai",
  displayName: "OpenAI",
  kind: "cloud",
  enabled: true,
  requiresApiKey: true,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  timeoutMs: 30_000,
  apiKey: "test-key",
  apiKeyEnvVar: "OPENAI_API_KEY",
  envVars: ["OPENAI_API_KEY"],
  fileConfig: {},
  configured: true,
  available: true,
  reason: "configured"
};

describe("orchestration", () => {
  it("builds plans with explicit completion checks", () => {
    const plan = buildOrchestrationPlan("fix src/agent/queryEngine.ts and validate", {
      workspace: process.cwd(),
      currentProvider: provider,
      permissionMode: "plan"
    });

    expect(plan.goals).toHaveLength(3);
    expect(plan.goals.every((goal) => goal.completionChecks.length > 0)).toBe(true);
    expect(plan.goals.flatMap((goal) => goal.completionChecks).some((check) => check.type === "path-exists")).toBe(true);
    expect(plan.goals.flatMap((goal) => goal.completionChecks).some((check) => check.type === "package-script-present")).toBe(true);
    expect(plan.goals.flatMap((goal) => goal.actions).some((action) => action.type === "inspect-pattern")).toBe(true);
  });

  it("executes checks and marks the run complete only when checks pass", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-orchestration-"));
    tempDirs.push(workspace);
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ scripts: { typecheck: "node -e \"process.stdout.write('ok')\"" } }),
      "utf8"
    );
    await writeFile(path.join(workspace, "main.ts"), "export const ready = true;\n", "utf8");

    const context: OrchestrationContext = {
      workspace,
      currentProvider: provider,
      permissionMode: "plan"
    };
    const plan = buildOrchestrationPlan("create src/new-feature.ts", context);
    const execution = await executeOrchestrationPlan(plan, context);
    const reflector = reflectOnExecution(plan.goals, execution);

    expect(execution.failed.length).toBeGreaterThanOrEqual(1);
    expect(execution.gaps.some((gap) => gap.description.includes("missing src/new-feature.ts"))).toBe(true);
    expect(reflector.decision).toBe("approval-required");
    expect(reflector.isComplete).toBe(false);
  });

  it("escalates when the same gap repeats", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-orchestration-"));
    tempDirs.push(workspace);

    const context: OrchestrationContext = {
      workspace,
      currentProvider: null,
      permissionMode: "default"
    };
    const plan = buildOrchestrationPlan("create src/new-feature.ts", context);
    const execution = await executeOrchestrationPlan(plan, context);
    const repeatedSignature = buildGapSignature(execution.gaps);
    const reflector = reflectOnExecution(plan.goals, execution, [repeatedSignature]);

    expect(execution.gaps.length).toBeGreaterThan(0);
    expect(reflector.decision).toBe("escalated");
    expect(reflector.isComplete).toBe(false);
  });

  it("runs safe orchestration actions after checks pass", async () => {
    process.env.CODECLAW_ENABLE_REAL_LSP = "0";
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-orchestration-"));
    tempDirs.push(workspace);
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { typecheck: "node -e \"process.stdout.write('typecheck-ok')\"" } }), "utf8");
    await writeFile(path.join(workspace, "sample.ts"), "export function greetUser(name: string) {\n  return name;\n}\n", "utf8");

    const context: OrchestrationContext = {
      workspace,
      currentProvider: provider,
      permissionMode: "plan"
    };
    const plan = buildOrchestrationPlan("fix sample.ts greetUser", context);
    const execution = await executeOrchestrationPlan(plan, context);

    expect(execution.actionLogs.some((log) => log.includes("inspect-file sample.ts"))).toBe(true);
    expect(execution.actionLogs.some((log) => log.includes("inspect-symbol greetUser"))).toBe(true);
    expect(execution.actionLogs.some((log) => log.includes("inspect-references greetUser"))).toBe(true);
    expect(execution.actionLogs.some((log) => log.includes("run-package-script typecheck"))).toBe(true);
    expect(execution.observations.some((observation) => observation.detail === "ran package script typecheck")).toBe(true);
    expect(execution.observations.some((observation) => observation.detail === "inspected references for greetUser")).toBe(true);
  });

  it("requests approval for write-lane actions instead of auto-writing", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-orchestration-"));
    tempDirs.push(workspace);
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { typecheck: "node -e \"process.stdout.write('ok')\"" } }), "utf8");
    await writeFile(path.join(workspace, "main.ts"), "export const ready = true;\n", "utf8");

    const context: OrchestrationContext = {
      workspace,
      currentProvider: provider,
      permissionMode: "plan"
    };
    const plan = buildOrchestrationPlan("create src/new-feature.ts", context);
    const execution = await executeOrchestrationPlan(plan, context);
    const reflector = reflectOnExecution(plan.goals, execution);

    expect(execution.approvalRequests).toHaveLength(1);
    expect(execution.approvalRequests[0]?.target).toBe("src/new-feature.ts");
    expect(execution.actionLogs.some((log) => log.includes("request-write-approval write src/new-feature.ts: pending"))).toBe(true);
    expect(reflector.decision).toBe("approval-required");
  });

  it("reflects approved and denied orchestration approvals differently", () => {
    const approved = reflectOnApprovalOutcome(
      {
        id: "approval-1",
        actionId: "action-1",
        operation: "write",
        target: "src/new-feature.ts",
        reason: "create flow may need to modify src/new-feature.ts",
        status: "pending"
      },
      "approved"
    );
    const denied = reflectOnApprovalOutcome(
      {
        id: "approval-2",
        actionId: "action-2",
        operation: "replace",
        target: "src/app/App.tsx",
        reason: "fix flow may need to modify src/app/App.tsx",
        status: "pending"
      },
      "denied"
    );

    expect(approved.decision).toBe("replan");
    expect(approved.newGoals[0]?.description).toContain("Execute approved write flow");
    expect(denied.decision).toBe("escalated");
    expect(denied.gaps[0]?.rootCause).toBe("approval denied by user");
  });

  it("materializes approved write and replace plans into local tool commands", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-orchestration-"));
    tempDirs.push(workspace);
    await writeFile(
      path.join(workspace, "existing.ts"),
      [
        "export function existingFeature() {",
        '  return "ready";',
        "}",
        "",
        "export const ready = true;",
        ""
      ].join("\n"),
      "utf8"
    );

    const writePlan = await buildApprovedExecutionPlan(
      {
        id: "approval-write",
        actionId: "action-write",
        operation: "write",
        target: "new-file.ts",
        reason: "create flow may need to modify new-file.ts",
        status: "pending",
        planGoal: "create new-file.ts"
      },
      workspace
    );
    const replacePlan = await buildApprovedExecutionPlan(
      {
        id: "approval-replace",
        actionId: "action-replace",
        operation: "replace",
        target: "existing.ts",
        reason: "fix flow may need to modify existing.ts",
        status: "pending",
        planGoal: "fix existing.ts"
      },
      workspace
    );

    expect(writePlan.toolName).toBe("write");
    expect(writePlan.prompt).toContain("/write new-file.ts ::");
    expect(writePlan.prompt).toContain("Generated scaffold for approved orchestration goal: create new-file.ts");
    expect(writePlan.prompt).toContain("export interface NewFileInput");
    expect(writePlan.prompt).toContain("export function newFile");
    expect(replacePlan.toolName).toBe("write");
    expect(replacePlan.prompt).toContain(
      "/write existing.ts :: export function existingFeature() {\n  const existingFeatureApprovedPatchMarker = \"existingFeature-approved\";\n  void existingFeatureApprovedPatchMarker;\n  return \"ready\";\n}"
    );
    expect(replacePlan.prompt).toContain("export const ready = true;");
    expect(replacePlan.prompt).not.toContain("export function applyExistingApprovedPatch()");
  });

  it("inserts deterministic patch lines before python returns when fixing a function target", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-orchestration-"));
    tempDirs.push(workspace);
    await writeFile(
      path.join(workspace, "worker.py"),
      [
        "def existing_worker():",
        '    return "ready"',
        ""
      ].join("\n"),
      "utf8"
    );

    const replacePlan = await buildApprovedExecutionPlan(
      {
        id: "approval-python",
        actionId: "action-python",
        operation: "replace",
        target: "worker.py",
        reason: "fix flow may need to modify worker.py",
        status: "pending",
        planGoal: "fix existing_worker in worker.py"
      },
      workspace
    );

    expect(replacePlan.prompt).toContain("def existing_worker():");
    expect(replacePlan.prompt).toContain('    existing_worker_approved_patch_marker = "existing_worker_approved"');
    expect(replacePlan.prompt).toContain("    _ = existing_worker_approved_patch_marker");
    expect(replacePlan.prompt).toContain('    return "ready"');
  });

  it("appends a deterministic patch after the best non-function anchor when no function target matches", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-orchestration-"));
    tempDirs.push(workspace);
    await writeFile(
      path.join(workspace, "flags.ts"),
      [
        "export const ready = true;",
        "",
        "export const stable = true;",
        ""
      ].join("\n"),
      "utf8"
    );

    const replacePlan = await buildApprovedExecutionPlan(
      {
        id: "approval-flags",
        actionId: "action-flags",
        operation: "replace",
        target: "flags.ts",
        reason: "fix flow may need to modify flags.ts",
        status: "pending",
        planGoal: "fix flags.ts"
      },
      workspace
    );

    expect(replacePlan.prompt).toContain("export const ready = true;");
    expect(replacePlan.prompt).toContain("export const stable = true;");
    expect(replacePlan.prompt).toContain('export function applyFlagsApprovedPatch(): string {\n  return "flags-approved";\n}');
  });
});
