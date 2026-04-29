// 渲染节流调度器（v0.8.4，参考 codex-rs/tui/src/tui/frame_rate_limiter.rs）
//
// 把高频 setState 请求合并到固定 interval 的"帧"内，避免 ink 整树 reconcile + ANSI 全屏写出
// 把 pty buffer 灌爆。codex 同等设计：FrameRateLimiter clamp 到 120FPS + FrameScheduler 合并多
// 次 schedule_frame 请求为单次 draw_tx 通知。
//
// codeclaw 用 ink (React reconciler)，渲染开销远高于 ratatui，60-120FPS 不现实；选 50ms ≈ 20FPS
// 作为 hard cap。配合 newline-gated commit (§3.1.B)，commit 路径实际 setState 频率 ~1Hz。

export class FrameScheduler {
  private lastEmittedAt = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingActions = new Map<string, () => void>();

  constructor(
    private readonly minIntervalMs: number,
    private readonly setTimeoutFn: typeof setTimeout = setTimeout,
    private readonly clearTimeoutFn: typeof clearTimeout = clearTimeout,
    private readonly nowFn: () => number = Date.now
  ) {}

  // 同 key 后到 action 覆盖前者；timer 还没 fire 时不再 schedule，让多 key 合并到同一帧
  schedule(key: string, action: () => void): void {
    this.pendingActions.set(key, action);
    if (this.pendingTimer) return;

    const now = this.nowFn();
    const earliest = this.lastEmittedAt + this.minIntervalMs;
    const delay = Math.max(0, earliest - now);

    this.pendingTimer = this.setTimeoutFn(() => this.flush(), delay);
  }

  // 测试用 / 进程退出前清空：立即跑所有 pending action
  flushNow(): void {
    if (this.pendingTimer) {
      this.clearTimeoutFn(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.flush();
  }

  // pending 数量（测试 / debug 用）
  pendingCount(): number {
    return this.pendingActions.size;
  }

  private flush(): void {
    this.pendingTimer = null;
    this.lastEmittedAt = this.nowFn();
    const actions = Array.from(this.pendingActions.values());
    this.pendingActions.clear();
    // React 18 自动 batch 同步连续 setState
    for (const action of actions) {
      try {
        action();
      } catch {
        // action 抛错不能影响后续 action 执行；上层应自行处理
      }
    }
  }
}

export const frameScheduler = new FrameScheduler(50);
