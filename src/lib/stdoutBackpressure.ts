// stdout backpressure 检测（v0.8.5 Phase 3）
//
// 背景：codex 用 Rust 同步 io::Write 写终端，buffer 满了 write 系统调用阻塞调用方，反压
// 自动传到 LLM stream 消费层。codeclaw 用 Node 异步 stream，buffer 满时 write 不阻塞，
// 字节会持续在 Node 内部 buffer 累积 → 终端 GUI 处理不过来 → 反向 hang。
//
// 治法：每个 yield 之前检测 process.stdout.writableNeedDrain，反压时 await drain；
// 等不到就发 stall 警告但继续等（终端真死了跳过去 yield 也写不出，跟着 hang 比 silently
// 累积更明显，用户能 Ctrl+C）。

export interface BackpressureAuditEvent {
  actor: "engine";
  action: "stream.backpressure-stalled" | "stream.backpressure-cleared";
  waitedMs: number;
  reason?: string;
}

export interface WaitOptions {
  /** 注入 stdout 接口便于测试 */
  stream?: NodeJS.WriteStream;
  /** stall 警告间隔；默认 5 秒 */
  stallWarnIntervalMs?: number;
  /** audit 回调，stall / cleared 时发送 */
  onAudit?: (event: BackpressureAuditEvent) => void;
  /** 测试用注入 setTimeout / setInterval / Date.now */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  nowFn?: () => number;
}

export async function waitForStdoutDrain(opts: WaitOptions = {}): Promise<void> {
  const stream = opts.stream ?? process.stdout;
  // Node 22+ 才有 writableNeedDrain；老版本无此字段视为始终无反压
  const needDrain = (stream as NodeJS.WriteStream & { writableNeedDrain?: boolean })
    .writableNeedDrain;
  if (!needDrain) return;

  const stallInterval = opts.stallWarnIntervalMs ?? 5_000;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  const nowFn = opts.nowFn ?? Date.now;
  const startedAt = nowFn();

  return new Promise<void>((resolve) => {
    let stallTimer: ReturnType<typeof setInterval> | null = null;
    const onDrain = (): void => {
      if (stallTimer !== null) clearIntervalFn(stallTimer);
      const waitedMs = nowFn() - startedAt;
      if (waitedMs > 1_000 && opts.onAudit) {
        opts.onAudit({
          actor: "engine",
          action: "stream.backpressure-cleared",
          waitedMs,
        });
      }
      resolve();
    };
    stream.once("drain", onDrain);
    stallTimer = setIntervalFn(() => {
      const waitedMs = nowFn() - startedAt;
      if (opts.onAudit) {
        opts.onAudit({
          actor: "engine",
          action: "stream.backpressure-stalled",
          waitedMs,
          reason: `stdout drain not fired in ${waitedMs}ms; terminal may be hung`,
        });
      }
    }, stallInterval);
  });
}
