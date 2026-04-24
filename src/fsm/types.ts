/**
 * 引擎状态机 · 类型契约（W2-03）
 *
 * 设计目标：
 *   - 把目前散落在 QueryEngine 各字段（pendingApprovals / interrupted /
 *     reactiveCompactCount / activeSkill 等）里的"我们走到哪一步了"语义，
 *     收敛为一组显式 phase + halt reason，便于：
 *     · /status /cost /audit 输出更精确
 *     · 跨 worker / channel / SDK 共享同一套词汇
 *     · 审计链记录"为什么停"而不是"停了"
 *
 * 非目标（W2 阶段）：
 *   - 不强行替换 QueryEngine 现有字段（侵入性大）；FSM 先以"并行观测"提供给
 *     消费者（/cost、orchestration、新命令）使用，逐步收敛。
 *   - 不引入跨进程同步；当前是单引擎实例内一份状态。
 */

/** 引擎主流程的几种"宏观相位"。不细到每一步工具调用层级。 */
export type EnginePhase =
  | "idle"        // 静止，没有处理中的请求
  | "planning"    // 解析用户输入、构造执行 plan
  | "executing"   // 工具 / skill / MCP 调用进行中
  | "reflecting"  // executor 完成，正在做 reflector 分析
  | "compacting"  // 主动 / 被动压缩对话历史
  | "awaiting"    // 等用户输入（如审批、外部触发）
  | "halted";     // 已停止（成功 / 失败 / 主动停）

/** 当处于 halted 时，更精细的"为什么停了"。 */
export type HaltReason =
  | "completed"          // 自然完成
  | "user-cancelled"     // 用户主动 Ctrl+C / /exit / interrupt
  | "approval-required"  // 工具或编排需用户审批，引擎自暂停
  | "approval-denied"    // 用户拒绝审批
  | "max-turns"          // 达到 Planner-Executor-Reflector 最大循环次数
  | "max-tokens"         // 达到 token 预算
  | "tool-failure"       // 工具调用失败到不可恢复
  | "provider-failure"   // LLM provider 失败 / fallback 也死
  | "internal-error";    // 引擎内部异常

/** halted 时这一轮工作算什么程度的"完成"。与 reason 是正交的两个维度。 */
export type CompletionKind =
  | "success"   // 目标完成
  | "partial"   // 部分达成、有未解决的子目标
  | "blocked"   // 被外部因素挡住（等审批 / 等用户决策）
  | "failed"    // 错误致死，未达成目标
  | "abandoned"; // 用户或上游主动放弃

/** halted 状态的具体快照 */
export interface HaltState {
  reason: HaltReason;
  completion: CompletionKind;
  /** 给用户/审计读的一段说明 */
  message?: string;
  /** 在第几轮 P-E-R 循环上 halt，便于排查"是否一开始就 halt" */
  turn?: number;
  /** 哪个 trace 上 halt（便于跨 trace 关联） */
  traceId?: string;
  /** 触发时间（毫秒） */
  occurredAt: number;
}

/** FSM 对外可见的快照，UI / /status / /cost 可以直接消费 */
export interface FsmSnapshot {
  phase: EnginePhase;
  /** halted 时一定有；其它 phase 可能保留上一次 halt 用于回顾 */
  lastHalt: HaltState | null;
  /** 当前 turn 计数（每次 user 输入 +1） */
  turn: number;
  /** 进入当前 phase 的时间戳，便于看"卡住多久" */
  enteredAt: number;
}

/** 转移事件（订阅用） */
export interface FsmTransitionEvent {
  from: EnginePhase;
  to: EnginePhase;
  at: number;
  /** 转到 halted 时携带 halt 详情 */
  halt?: HaltState;
}

export type FsmListener = (event: FsmTransitionEvent) => void;
