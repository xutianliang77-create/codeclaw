/**
 * Python sandbox · runPython 单测 · #83
 *
 * 测试需要 python3 在 PATH 下；不可用时 spawn-error 路径仍要 graceful。
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { runPython, resolvePythonBin } from "../../../src/skills/sandbox/python";

function pythonAvailable(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

describe("resolvePythonBin", () => {
  it("默认 python3", () => {
    expect(resolvePythonBin({})).toBe("python3");
  });
  it("CODECLAW_PYTHON 覆盖", () => {
    expect(resolvePythonBin({ CODECLAW_PYTHON: "/opt/python/bin/python3.13" })).toBe(
      "/opt/python/bin/python3.13"
    );
  });
});

describe("runPython", () => {
  it("缺 code/scriptPath → 抛错", async () => {
    await expect(runPython({})).rejects.toThrow(/need code or scriptPath/);
  });

  it("同时给 code 和 scriptPath → 抛错", async () => {
    await expect(
      runPython({ code: "print(1)", scriptPath: "/tmp/x.py" })
    ).rejects.toThrow(/cannot pass both/);
  });

  it("python 不存在 → 失败但不抛（mem-limited 路径走 bash → exit 127；spawn 失败 → -1）", async () => {
    const r = await runPython({ code: "print(1)", pythonBin: "/no/such/python" });
    expect(r.exitCode).not.toBe(0); // 任意非零都算捕获到失败
    expect(r.stderr).toBeTruthy();
  });

  if (pythonAvailable()) {
    it("正常 print → exitCode=0 + stdout", async () => {
      const r = await runPython({ code: "print('hello')" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("hello");
      expect(r.timedOut).toBe(false);
    });

    it("python 抛错 → exitCode≠0 + stderr 含 Error", async () => {
      // 注：mem-limited 路径走 python - + stdin，"this is not python" 解析为表达式触发 NameError；
      // 用确定的 SyntaxError 例子让两条路径行为一致
      const r = await runPython({ code: "def(:" });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toMatch(/Error/);
    });

    it("超时 → timedOut=true + signal='timeout'", async () => {
      const r = await runPython({
        code: "import time; time.sleep(2)",
        timeoutMs: 200,
      });
      expect(r.timedOut).toBe(true);
      expect(r.signal).toBe("timeout");
    }, 8000);

    it("stdin 输入 → python 能读到（关掉 mem 限制）", async () => {
      const r = await runPython({
        code: "import sys; print(sys.stdin.read().upper())",
        stdin: "hello",
        maxMemoryMb: 0, // 关 mem 限制让 stdin 给 user
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("HELLO");
    });

    const oomCase = process.platform === "linux" ? it : it.skip;

    oomCase("内存限制：分配超 256MB → OOM 退出（非零）", async () => {
      // 分配 ~400MB bytes 应触发 ulimit -v 限制
      const r = await runPython({
        code: "x = bytearray(400 * 1024 * 1024); print('did-not-oom')",
        maxMemoryMb: 256,
        timeoutMs: 5_000,
      });
      // ulimit -v 触发时 python 通常 MemoryError 抛错，exit≠0；偶尔环境差异 → 至少不应该 print success
      expect(r.stdout).not.toContain("did-not-oom");
    }, 8000);

    it("maxMemoryMb=0 → 不限制，大内存分配可成功", async () => {
      const r = await runPython({
        code: "x = bytearray(10 * 1024 * 1024); print('ok')",
        maxMemoryMb: 0,
        timeoutMs: 5_000,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("ok");
    });

    it("env 覆盖 → python 能读到", async () => {
      const r = await runPython({
        code: "import os; print(os.environ.get('CODECLAW_TEST_VAR', 'missing'))",
        env: { CODECLAW_TEST_VAR: "value42" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("value42");
    });

    it("abortSignal 触发 → 立即结束", async () => {
      const ac = new AbortController();
      const promise = runPython({
        code: "import time; time.sleep(5); print('should not reach')",
        timeoutMs: 10_000,
        abortSignal: ac.signal,
      });
      setTimeout(() => ac.abort(), 50);
      const r = await promise;
      expect(r.stdout).not.toContain("should not reach");
    }, 8000);
  } else {
    it.skip("python3 不可用，跳过实运行测试", () => {});
  }
});
