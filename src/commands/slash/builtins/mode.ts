/**
 * `/mode` · 查看 / 切换 permission mode
 *
 * 无参 → 返回当前 mode
 * 有参 → 切到指定 mode（不识别的 mode 报错并列出可选）
 *
 * handler 通过 context.queryEngine 拿到一个实现了 PermissionModeHolder 的对象。
 * 不直接 import queryEngine（避免循环依赖），而是做 duck-typed cast。
 */

import { defineCommand, reply } from "../registry";

export type PermissionMode =
  | "default"
  | "plan"
  | "auto"
  | "acceptEdits"
  | "bypassPermissions"
  | "dontAsk";

export const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "plan",
  "auto",
  "acceptEdits",
  "bypassPermissions",
  "dontAsk",
];

interface PermissionModeHolder {
  permissionMode: PermissionMode;
  permissions: { setMode(mode: PermissionMode): void };
  /** W3-01：优先走统一入口 runModeCommand（含审计）；不存在时退回直接动字段（v1 兼容） */
  runModeCommand?(prompt: string): string;
}

function isHolder(x: unknown): x is PermissionModeHolder {
  if (!x || typeof x !== "object") return false;
  const obj = x as Record<string, unknown>;
  const perms = obj.permissions as Record<string, unknown> | undefined;
  return (
    typeof obj.permissionMode === "string" &&
    !!perms &&
    typeof perms.setMode === "function"
  );
}

export default defineCommand({
  name: "/mode",
  category: "permission",
  risk: "medium",
  summary: "Show or switch permission mode (default/plan/auto/acceptEdits/bypassPermissions/dontAsk).",
  helpDetail:
    "Usage:\n" +
    "  /mode                  show current mode\n" +
    "  /mode <name>           switch to <name>\n" +
    "\nModes: " + PERMISSION_MODES.join(", "),
  handler(ctx) {
    const { argsRaw, queryEngine } = ctx;
    if (!isHolder(queryEngine)) {
      return reply("mode command unavailable: runtime does not expose permission state");
    }

    // 优先走统一入口（含 W3-01 audit），缺失时退回 v1 直接 setField + setMode
    if (typeof queryEngine.runModeCommand === "function") {
      return reply(queryEngine.runModeCommand(ctx.rawPrompt));
    }

    const nextMode = argsRaw.trim();
    if (!nextMode) {
      return reply(`current mode: ${queryEngine.permissionMode}`);
    }

    if (!PERMISSION_MODES.includes(nextMode as PermissionMode)) {
      return reply(
        `unknown mode: ${nextMode}\navailable: ${PERMISSION_MODES.join(", ")}`
      );
    }

    queryEngine.permissionMode = nextMode as PermissionMode;
    queryEngine.permissions.setMode(nextMode as PermissionMode);
    return reply(`mode set to ${queryEngine.permissionMode}`);
  },
});
