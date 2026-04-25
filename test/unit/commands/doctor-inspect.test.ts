/**
 * doctor 扩展（W4）· inspect / probe 纯函数单测
 *
 * 覆盖：
 *   - inspectAuditChain：缺文件 / 链 ok
 *   - inspectApprovalsPending：缺文件 / 有 pending 数
 *   - probeBaseUrl：起本地 http server 探活成功 / 不可达 host 超时失败
 */

import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  inspectApprovalsPending,
  inspectAuditChain,
  probeBaseUrl,
} from "../../../src/commands/doctor";
import { openAuditDb } from "../../../src/storage/audit";
import { AuditLog } from "../../../src/storage/auditLog";
import { savePendingApprovals } from "../../../src/approvals/store";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function mkTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-doctor-"));
  tempDirs.push(dir);
  return dir;
}

describe("inspectAuditChain", () => {
  it("audit.db 不存在 → { skipped: true }", () => {
    const r = inspectAuditChain(path.join(mkTempDir(), "missing.db"));
    expect(r).toEqual({ skipped: true });
  });

  it("链完好 → ok 含事件数与耗时", () => {
    const dbPath = path.join(mkTempDir(), "audit.db");
    const handle = openAuditDb({ path: dbPath, singleton: false });
    new AuditLog(handle.db).append({
      traceId: "t1",
      actor: "user",
      action: "test:event",
      decision: "allow",
    });
    new AuditLog(handle.db).append({
      traceId: "t2",
      actor: "user",
      action: "test:event2",
      decision: "allow",
    });
    handle.close();

    const r = inspectAuditChain(dbPath);
    expect("ok" in r).toBe(true);
    if (!("ok" in r)) throw new Error("expected verify result");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.checked).toBe(2);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  // 安全：审计链端到端 tampering 检测（W4-B-SEC-2）
  // 攻击意图：attacker 拿到 audit.db 写权限后直接 SQL UPDATE 改某条事件的 resource，
  // 期望事件本身改了但旁观者看不出来。
  // 防御：event_hash 包含 resource，链断在被改的位置，verify 应能精确报警。
  it("SEC: 直接 SQL 改 audit_events.resource 后，inspectAuditChain 报 BROKEN", () => {
    const dbPath = path.join(mkTempDir(), "audit.db");
    const handle = openAuditDb({ path: dbPath, singleton: false });
    const log = new AuditLog(handle.db);
    log.append({ traceId: "t1", actor: "user", action: "test:e1", decision: "allow", resource: "r1" });
    log.append({ traceId: "t2", actor: "user", action: "test:e2", decision: "allow", resource: "r2" });
    log.append({ traceId: "t3", actor: "user", action: "test:e3", decision: "allow", resource: "r3" });

    // attacker 改第二条 resource（例如把 "/etc/shadow" 伪装成 "/tmp/innocent"）
    handle.db
      .prepare("UPDATE audit_events SET resource = 'tampered' WHERE trace_id = ?")
      .run("t2");
    handle.close();

    const r = inspectAuditChain(dbPath);
    expect("ok" in r).toBe(true);
    if (!("ok" in r)) throw new Error("expected verify result");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected broken");
    expect(r.brokenAt).toBeTruthy();
    expect(r.reason).toBeTruthy();
  });
});

describe("inspectApprovalsPending", () => {
  it("data.db 不存在 → null", () => {
    expect(inspectApprovalsPending(path.join(mkTempDir(), "missing.db"))).toBeNull();
  });

  it("有 pending → 数对", () => {
    const dir = mkTempDir();
    // store 内部用 <approvalsDir>/../data.db 反推 data.db 路径
    const approvalsDir = path.join(dir, "approvals");
    savePendingApprovals(approvalsDir, [
      {
        id: "a1",
        prompt: "/bash rm -rf",
        toolName: "bash",
        detail: "rm -rf",
        reason: "destructive",
        createdAt: new Date().toISOString(),
      },
      {
        id: "a2",
        prompt: "/bash sudo",
        toolName: "bash",
        detail: "sudo",
        reason: "privilege",
        createdAt: new Date().toISOString(),
      },
    ]);
    const dataDbPath = path.join(dir, "data.db");
    expect(inspectApprovalsPending(dataDbPath)).toBe(2);
  });
});

describe("probeBaseUrl", () => {
  it("可达 → ok=true 含状态码与耗时", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const r = await probeBaseUrl(`http://127.0.0.1:${port}`, 1000);
      expect(r.ok).toBe(true);
      expect(r.status).toBe(200);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("不可达 host → ok=false（fetch failed 或 timeout）", async () => {
    // 192.0.2.0/24 是 RFC 5737 documentation prefix，路由黑洞
    const r = await probeBaseUrl("http://192.0.2.1:80", 500);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
