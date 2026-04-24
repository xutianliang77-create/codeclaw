/**
 * `/commit` · git 提交预览（read-only）
 *
 * 当前实现：纯只读 — 跑 `git status --porcelain` + `git diff --stat HEAD`，
 * 把当前工作区变更摆出来给用户决策。**不主动 git commit**：
 *   - 自动 commit 涉及消息生成 + 不可逆副作用，需走审批 / message generator，
 *     设计议题留 W2-04+ 单独做。
 *
 * 输入：可选 message（透给未来真正能 commit 的版本，先忽略）。
 */

import { execFileSync } from "node:child_process";
import { defineCommand, reply } from "../registry";

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

    return reply(
      [
        "Commit preview (read-only)",
        `branch: ${branch}`,
        "",
        "git status --porcelain:",
        statusLines || "  (no entries)",
        "",
        "git diff --stat HEAD:",
        diffLines || "  (no diff)",
        "",
        "next: run `git add -A && git commit -m \"...\"` yourself if this looks right.",
      ].join("\n")
    );
  },
});
