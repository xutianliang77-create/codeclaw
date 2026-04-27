/**
 * `/commit` · git 提交预览（read-only）+ secret 扫描
 *
 * 当前实现：纯只读 — 跑 `git status --porcelain` + `git diff --stat HEAD` +
 * 扫描 `git diff HEAD` 实际 patch 找 secret（W4-05/06）。**不主动 git commit**。
 *
 * Secret 命中只警告不阻塞——用户决定是否继续。规则集见 src/lib/secretScan.ts。
 */

import { execFileSync } from "node:child_process";
import { defineCommand, reply } from "../registry";
import { formatFindings, scanForSecrets } from "../../../lib/secretScan";

interface CommitHolder {
  /** 可选：让宿主指定 cwd（测试 / 多仓场景）。缺省走 process.cwd() */
  getWorkspaceRoot?(): string;
}

function getCwd(holder: unknown): string {
  if (holder && typeof (holder as CommitHolder).getWorkspaceRoot === "function") {
    return (holder as CommitHolder).getWorkspaceRoot!();
  }
  return process.cwd();
}

function gitOrEmpty(args: string[], cwd: string): { ok: boolean; stdout: string; err?: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      err: err instanceof Error ? err.message : String(err),
    };
  }
}

export default defineCommand({
  name: "/commit",
  category: "workflow",
  risk: "low",
  summary: "Preview pending git changes (status + diff stat). Read-only.",
  summaryZh: "预览待提交的 git 改动（status + diff stat），只读",
  helpDetail:
    "Read-only preview. Runs:\n" +
    "  git status --porcelain\n" +
    "  git diff --stat HEAD\n" +
    "Auto-commit (with message generation) is intentionally out of scope for now —\n" +
    "you decide whether to actually commit.",
  handler(ctx) {
    const cwd = getCwd(ctx.queryEngine);
    const status = gitOrEmpty(["status", "--porcelain"], cwd);
    if (!status.ok) {
      return reply(`commit preview unavailable: not a git repo or git failed.\n${status.err ?? ""}`.trim());
    }
    const diffStat = gitOrEmpty(["diff", "--stat", "HEAD"], cwd);
    const branchOut = gitOrEmpty(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    // 实际 patch 内容用于 secret 扫描；输出可能很大，限制 1MB
    const diffPatch = gitOrEmpty(["diff", "HEAD"], cwd);
    const findings = diffPatch.ok ? scanForSecrets(diffPatch.stdout) : [];

    const branch = branchOut.ok ? branchOut.stdout.trim() : "?";
    const statusLines = status.stdout.trim();
    const diffLines = diffStat.stdout.trim();

    if (!statusLines && !diffLines) {
      return reply(
        [
          "Commit preview",
          `branch: ${branch}`,
          "working tree clean — nothing to commit.",
        ].join("\n")
      );
    }

    const lines: string[] = [
      "Commit preview (read-only)",
      `branch: ${branch}`,
      "",
      "git status --porcelain:",
      statusLines || "  (no entries)",
      "",
      "git diff --stat HEAD:",
      diffLines || "  (no diff)",
    ];

    if (findings.length > 0) {
      lines.push("", "--- secret scan ---", formatFindings(findings));
    }

    lines.push(
      "",
      'next: run `git add -A && git commit -m "..."` yourself if this looks right.'
    );

    return reply(lines.join("\n"));
  },
});
