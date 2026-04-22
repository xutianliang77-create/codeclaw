import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGapSignature, buildOrchestrationPlan, executeOrchestrationPlan, reflectOnExecution } from "../src/orchestration";
import type { OrchestrationContext, ReflectorResult } from "../src/orchestration";
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

interface PlaybackScenario {
  name: string;
  goal: string;
  permissionMode: OrchestrationContext["permissionMode"];
  provider: ProviderStatus | null;
  files: Array<{ path: string; content: string }>;
  expectedIntent: string;
  expectedDecision: ReflectorResult["decision"];
  expectedActionLogIncludes?: string[];
  expectedGapIncludes?: string[];
  repeatFailure?: boolean;
}

async function createWorkspace(files: PlaybackScenario["files"], withTypecheck = false): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "codeclaw-playback-"));
  tempDirs.push(workspace);

  if (withTypecheck) {
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ scripts: { typecheck: "node -e \"process.stdout.write('ok')\"" } }),
      "utf8"
    );
  }

  for (const file of files) {
    const absolutePath = path.join(workspace, file.path);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.content, "utf8");
  }

  return workspace;
}

async function runPlaybackScenario(scenario: PlaybackScenario): Promise<{
  plan: ReturnType<typeof buildOrchestrationPlan>;
  reflector: ReflectorResult;
  execution: Awaited<ReturnType<typeof executeOrchestrationPlan>>;
}> {
  process.env.CODECLAW_ENABLE_REAL_LSP = "0";
  const workspace = await createWorkspace(
    scenario.files,
    scenario.expectedDecision === "approval-required" || scenario.expectedDecision === "replan"
  );
  const context: OrchestrationContext = {
    workspace,
    currentProvider: scenario.provider,
    permissionMode: scenario.permissionMode
  };
  const plan = buildOrchestrationPlan(scenario.goal, context);
  const execution = await executeOrchestrationPlan(plan, context);
  const repeatedGapSignatures = scenario.repeatFailure ? [buildGapSignature(execution.gaps)] : [];
  const reflector = reflectOnExecution(plan.goals, execution, repeatedGapSignatures);

  return { plan, execution, reflector };
}

const scenarios: PlaybackScenario[] = [
  {
    name: "analyze existing function implementation",
    goal: "analyze src/sample.ts greetUser",
    permissionMode: "plan",
    provider,
    files: [{ path: "src/sample.ts", content: "export function greetUser(name: string) {\n  return name;\n}\n" }],
    expectedIntent: "analyze",
    expectedDecision: "complete",
    expectedActionLogIncludes: ["inspect-file src/sample.ts", "inspect-symbol greetUser", "inspect-references greetUser"]
  },
  {
    name: "review query engine entrypoint",
    goal: "review src/entry.ts createQueryEngine",
    permissionMode: "plan",
    provider,
    files: [{ path: "src/entry.ts", content: "export function createQueryEngine() {\n  return 'ready';\n}\n" }],
    expectedIntent: "analyze",
    expectedDecision: "complete",
    expectedActionLogIncludes: ["inspect-file src/entry.ts", "inspect-symbol createQueryEngine"]
  },
  {
    name: "query how a symbol works in a file",
    goal: "how createQueryEngine works in src/entry.ts?",
    permissionMode: "plan",
    provider,
    files: [{ path: "src/entry.ts", content: "export function createQueryEngine() {\n  return 'ready';\n}\n" }],
    expectedIntent: "query",
    expectedDecision: "complete",
    expectedActionLogIncludes: ["inspect-file src/entry.ts", "inspect-symbol createQueryEngine"]
  },
  {
    name: "analyze workspace without explicit file targets",
    goal: "analyze architecture",
    permissionMode: "plan",
    provider,
    files: [{ path: "src/sample.ts", content: "export const ready = true;\n" }],
    expectedIntent: "analyze",
    expectedDecision: "complete",
    expectedActionLogIncludes: ["inspect-pattern src/**/*.ts"]
  },
  {
    name: "query symbol references without write lane",
    goal: "where greetUser is used in src/sample.ts?",
    permissionMode: "plan",
    provider,
    files: [{ path: "src/sample.ts", content: "export function greetUser(name: string) {\n  return name;\n}\n" }],
    expectedIntent: "query",
    expectedDecision: "complete",
    expectedActionLogIncludes: ["inspect-file src/sample.ts", "inspect-symbol greetUser"]
  },
  {
    name: "fix existing function requires approval",
    goal: "fix src/sample.ts greetUser",
    permissionMode: "plan",
    provider,
    files: [{ path: "src/sample.ts", content: "export function greetUser(name: string) {\n  return name;\n}\n" }],
    expectedIntent: "fix",
    expectedDecision: "approval-required",
    expectedActionLogIncludes: ["run-package-script typecheck", "request-write-approval replace src/sample.ts: pending"]
  },
  {
    name: "create new feature scaffold requires approval",
    goal: "create src/new-feature.ts",
    permissionMode: "plan",
    provider,
    files: [{ path: "src/existing.ts", content: "export const ready = true;\n" }],
    expectedIntent: "create",
    expectedDecision: "approval-required",
    expectedGapIncludes: ["missing src/new-feature.ts"]
  },
  {
    name: "build docs scaffold requires approval",
    goal: "build docs/guide.md",
    permissionMode: "plan",
    provider,
    files: [{ path: "src/sample.ts", content: "export const ready = true;\n" }],
    expectedIntent: "create",
    expectedDecision: "approval-required",
    expectedGapIncludes: ["missing docs/guide.md"]
  },
  {
    name: "repeated provider-less task failure escalates",
    goal: "prepare escalated architecture walkthrough",
    permissionMode: "default",
    provider: null,
    files: [{ path: "src/existing.ts", content: "export const ready = true;\n" }],
    expectedIntent: "task",
    expectedDecision: "escalated",
    expectedGapIncludes: ["provider not configured or unavailable"],
    repeatFailure: true
  },
  {
    name: "task without provider falls back to replan",
    goal: "prepare architecture walkthrough",
    permissionMode: "default",
    provider: null,
    files: [{ path: "src/sample.ts", content: "export const ready = true;\n" }],
    expectedIntent: "task",
    expectedDecision: "replan",
    expectedGapIncludes: ["provider not configured or unavailable"]
  }
];

describe("phase 2 orchestration playbacks", () => {
  for (const scenario of scenarios) {
    it(`replays: ${scenario.name}`, async () => {
      const { plan, execution, reflector } = await runPlaybackScenario(scenario);

      expect(plan.intent.type).toBe(scenario.expectedIntent);
      expect(plan.goals.length).toBeGreaterThan(0);
      expect(plan.goals.every((goal) => goal.completionChecks.length > 0)).toBe(true);
      expect(reflector.decision).toBe(scenario.expectedDecision);

      for (const fragment of scenario.expectedActionLogIncludes ?? []) {
        expect(execution.actionLogs.some((log) => log.includes(fragment))).toBe(true);
      }

      for (const fragment of scenario.expectedGapIncludes ?? []) {
        expect(execution.gaps.some((gap) => gap.description.includes(fragment) || gap.rootCause.includes(fragment))).toBe(true);
      }
    });
  }
});
