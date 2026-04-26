/**
 * SubagentRegistry · per-engine 子 agent 运行追踪（B.8 后端 instrumentation）
 *
 * - 父 engine 持一个实例；Task tool 调用前 record，结束后 finalize
 * - in-memory only；engine 销毁随 GC，不持久化（重启后丢失，符合 B.8 当前预期）
 * - 上限 100 条；超出按 startedAt 切尾（保最近的）
 */

export interface SubagentRunRecord {
  id: string;
  role: string;
  prompt: string;
  status: "running" | "completed" | "failed" | "timeout";
  startedAt: number;
  finishedAt?: number;
  toolCallCount?: number;
  durationMs?: number;
  error?: string;
  /** 结果文本前 256 字符（避免巨型 transcript 占内存） */
  resultPreview?: string;
}

const MAX_RECORDS = 100;

export class SubagentRegistry {
  private records: SubagentRunRecord[] = [];
  private nextId = 1;

  start(input: { role: string; prompt: string }): SubagentRunRecord {
    const rec: SubagentRunRecord = {
      id: `sa-${this.nextId++}`,
      role: input.role,
      prompt: input.prompt.slice(0, 1024),
      status: "running",
      startedAt: Date.now(),
    };
    this.records.push(rec);
    if (this.records.length > MAX_RECORDS) {
      this.records.shift();
    }
    return rec;
  }

  finish(
    id: string,
    info: {
      ok: boolean;
      error?: string;
      toolCallCount: number;
      durationMs: number;
      resultText?: string;
    }
  ): void {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return;
    rec.status = info.ok ? "completed" : info.error?.includes("timeout") ? "timeout" : "failed";
    rec.finishedAt = Date.now();
    rec.toolCallCount = info.toolCallCount;
    rec.durationMs = info.durationMs;
    if (info.error) rec.error = info.error;
    if (info.resultText) rec.resultPreview = info.resultText.slice(0, 256);
  }

  list(): SubagentRunRecord[] {
    // 最近的在前
    return [...this.records].reverse();
  }

  size(): number {
    return this.records.length;
  }

  clear(): void {
    this.records = [];
  }
}
