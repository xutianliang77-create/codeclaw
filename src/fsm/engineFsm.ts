/**
 * EngineFsm · 引擎状态机本体（W2-03）
 *
 * 极简实现：
 *   - 管 phase 转移（无非法转移检查；调用方按文档自行约束）
 *   - 维护 turn 计数、lastHalt
 *   - 提供 listener 订阅
 *   - 提供 snapshot 出口（拷贝，不暴露内部引用）
 *
 * 不做：
 *   - 严格转移图（如 idle → reflecting 是允许的，因为 W2 阶段还没磨清楚所有合法路径）
 *   - 持久化（W2 内是进程内状态；落 audit / db 的工作交给消费者）
 *   - 多实例聚合（一个 QueryEngine 一个 EngineFsm）
 */

import type {
  CompletionKind,
  EnginePhase,
  FsmListener,
  FsmSnapshot,
  FsmTransitionEvent,
  HaltReason,
  HaltState,
} from "./types";

export class EngineFsm {
  private phase: EnginePhase = "idle";
  private enteredAt = Date.now();
  private turn = 0;
  private lastHalt: HaltState | null = null;
  private listeners: FsmListener[] = [];

  /** 用户递交了一条新输入：turn +1，phase 转到 planning */
  beginTurn(): void {
    this.turn += 1;
    this.transitionTo("planning");
  }

  /** 进入工具/skill 执行 */
  enterExecuting(): void {
    this.transitionTo("executing");
  }

  /** 进入 reflector 阶段 */
  enterReflecting(): void {
    this.transitionTo("reflecting");
  }

  /** 进入 / 退出 compacting（一次性瞬时阶段） */
  enterCompacting(): void {
    this.transitionTo("compacting");
  }

  /** 进入等待用户/外部输入 */
  enterAwaiting(): void {
    this.transitionTo("awaiting");
  }

  /** 一轮工作彻底停止 */
  halt(
    reason: HaltReason,
    completion: CompletionKind,
    opts: { message?: string; traceId?: string } = {}
  ): void {
    const halt: HaltState = {
      reason,
      completion,
      message: opts.message,
      traceId: opts.traceId,
      turn: this.turn,
      occurredAt: Date.now(),
    };
    this.lastHalt = halt;
    this.transitionTo("halted", halt);
  }

  /** 重置回 idle，不影响 turn 计数（用于"halted 后等下一条输入"场景） */
  resetToIdle(): void {
    this.transitionTo("idle");
  }

  on(listener: FsmListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  snapshot(): FsmSnapshot {
    return {
      phase: this.phase,
      lastHalt: this.lastHalt ? { ...this.lastHalt } : null,
      turn: this.turn,
      enteredAt: this.enteredAt,
    };
  }

  /** 给消费者直接读：当前是否处在 halted */
  isHalted(): boolean {
    return this.phase === "halted";
  }

  /** 给消费者直接读：当前 phase */
  currentPhase(): EnginePhase {
    return this.phase;
  }

  private transitionTo(next: EnginePhase, halt?: HaltState): void {
    const from = this.phase;
    const at = Date.now();
    this.phase = next;
    this.enteredAt = at;
    const ev: FsmTransitionEvent = { from, to: next, at, halt };
    for (const listener of this.listeners) {
      try {
        listener(ev);
      } catch {
        /* listener 抛错不影响其它订阅者 */
      }
    }
  }
}
