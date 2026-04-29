# RFC: codeclaw 渲染节流改造（参考 OpenAI codex）

**状态**：DRAFT，待用户拍板
**作者**：诊断 / 方案对齐于 2026-04-29 调试会话
**目标版本**：v0.8.4 → v0.9.x
**关联 commit**：v0.8.3 (`6ea6b40`) — 已修 EIO 立即退 + buffer 32MB + probe 远程跳检

---

## 1. 背景与根因

### 1.1 现象

Mac 上 codeclaw 跑 LLM 长任务（流式 27B 量化模型），用户离开 ≥ 10 分钟无输入后出现：

- **Terminal.app**：进程 OOM（4GB 堆爆）+ 11MB `crash.log`（14000 条 EIO 死循环）
- **Ghostty**：终端 hang（无 crash report，纯无响应）+ 26KB `crash.log`（30 条同模式 EIO 后戛然而止）

两次 EIO 堆栈的共同点：

```
Error: write EIO
  at Socket._writeGeneric
  at Ink.writeToStdout / writeToStderr
  at Object.onRender [as onImmediateRender]
  at debounce$1.edges.edges (es-toolkit)
```

### 1.2 排除项（已用现场数据排除的假设）

| 假设 | 排除依据 |
|---|---|
| Terminal.app 单点 bug | Ghostty 也死 |
| macOS sleep / wake 触发 | 现场抖音持有 wake lock 27 分钟，Mac 没真睡；pmset 无 Sleep/Wake 事件 |
| Ghostty app crash | `~/Library/Logs/DiagnosticReports/` 无 Ghostty crash report |
| MCP stdout buffer | mcp-*.log 不存在；mcp client stdout 处理路径与堆栈不符 |

### 1.3 真正根因

`src/app/App.tsx:309-316`：

```ts
if (event.type === "message-delta") {
  setMessages((current) =>
    current.map((message) =>
      message.id === event.messageId
        ? { ...message, text: message.text + event.delta }
        : message
    )
  );
  continue;
}
```

加上 `App.tsx:162-168`：

```ts
queryEngine.subscribe(() => {
  setRuntimeState(queryEngine.getRuntimeState());
  setMessages(queryEngine.getMessages());
  setPendingApproval(queryEngine.getPendingApproval());
});
```

**LLM 流式响应的每个 token 都触发 4-6 次 setState**：
- 1 次 `message-delta` event 处理（数组 .map）
- 3 次 `queryEngine.notifyListeners` subscriber（runtime / messages / approval）

LM Studio 27B 在 30 tok/s 下，**setState 频率 ~30Hz × 4-6 = 120-180Hz**。每次 setState → React re-render → ink reconciler → 写一堆 ANSI 字节到 stdout。

**触发链**：

```
LLM 流式响应中
  ↓
30 tok/s × 4-6 次 setState/token = 120-180Hz setState
  ↓
ink onImmediateRender × 高频 = 大量 ANSI 字节写 stdout
  ↓
用户离开 → 终端 GUI 进 macOS App Nap / 后台节流
  ↓
pty buffer (8-16KB) 消费速率 < codeclaw 写入速率
  ↓
buffer 爆 → write 阻塞 → 终端 GUI 也卡（pty 反压）
  ↓
EIO → uncaughtException → appendFileSync 写 crash.log
  ↓
进程要么 OOM（streamSseLines.buffer 同时累积），要么 hang
```

### 1.4 为什么 v0.7.0 之前没有

v0.7.0 起逐步把渲染压力推过临界点（每条单独不致命，累加突破 pty 容忍阈值）：

- **v0.7.0** native tools 默认开启（流式 token + 多轮 tool loop 替代单次 JSON）
- **v0.7.0** 全 UI 双语化（banner / footer / statusLine 文案变长，redraw 字节量翻倍）
- **v0.7.0** statusLine 数据层（增加 `statusLineText` state）
- **v0.7.x** subagent / artifact / ctx % 显示（message tree 加深）
- **v0.8.x** Context Engineering / LM Studio usage fallback（state 字段增加）

### 1.5 为什么 codex / Claude Code 不出现

Codex（Rust + ratatui）在 `codex-rs/tui/src/tui/` 下有 4 条核心保护机制（详见 §2）：

1. 120FPS hard cap（FrameRateLimiter）
2. Frame request coalescing（FrameScheduler actor）
3. 75ms trailing debounce for reflow（TranscriptReflow）
4. Synchronized output 协议（`stdout().sync_update`）

**codeclaw 一条都没有**。

---

## 2. Codex 设计参考

### 2.1 FrameRateLimiter — 120FPS hard cap

`codex-rs/tui/src/tui/frame_rate_limiter.rs:13`:

```rust
/// A 120 FPS minimum frame interval (≈8.33ms).
pub(super) const MIN_FRAME_INTERVAL: Duration = Duration::from_nanos(8_333_334);

impl FrameRateLimiter {
    pub(super) fn clamp_deadline(&self, requested: Instant) -> Instant {
        let last = self.last_emitted_at?;
        let min_allowed = last + MIN_FRAME_INTERVAL;
        requested.max(min_allowed)
    }
}
```

OpenAI 的源注释直接点出动机：

> Widgets sometimes call `FrameRequester::schedule_frame()` more frequently than a user can perceive. This limiter clamps draw notifications to a maximum of 120 FPS to avoid wasted work.

### 2.2 FrameScheduler — Actor + Coalescing

`codex-rs/tui/src/tui/frame_requester.rs`:

```rust
async fn run(mut self) {
    loop {
        tokio::select! {
            draw_at = self.receiver.recv() => {
                let draw_at = self.rate_limiter.clamp_deadline(draw_at);
                next_deadline = Some(next_deadline.map_or(draw_at, |cur| cur.min(draw_at)));
                continue;  // 关键：不立即 draw，让多个请求合并
            }
            _ = &mut deadline => {
                self.draw_tx.send(());
            }
        }
    }
}
```

> A single draw notification is sent for multiple requests scheduled before the next draw deadline.

任何 widget 调 `schedule_frame()` 经 mpsc 进单 task，多次请求合并为一次 draw。

### 2.3 TranscriptReflow — 75ms trailing debounce

`codex-rs/tui/src/transcript_reflow.rs:18`:

```rust
pub(crate) const TRANSCRIPT_REFLOW_DEBOUNCE: Duration = Duration::from_millis(75);
```

> Repeated resize events push the deadline out so dragging a terminal edge rebuilds scrollback at the final observed width rather than at intermediate widths.

resize / 大块输出走 75ms debounce，不响应中间状态。

### 2.4 Synchronized Output

`codex-rs/tui/src/tui.rs:679`:

```rust
stdout().sync_update(|_| {
    // 写一堆字节（光标移动、清行、重画）
})
```

发出 ANSI `\x1b[?2026h` 包裹多次 stdout write，让终端层把多 chunk 合并成一次渲染。Ghostty / iTerm2 / kitty 支持。

---

## 3. 改造方案（4 Phase）

### Phase 1 — Newline-gated commit + FrameScheduler

**⚠️ 本节经 §10 交叉验证后**已更新设计：从"简单 50ms 节流"改为"按换行 commit + partial line 节流"，更贴近 codex 的实际做法。

**目标**：消除 80% 高频 setState → redraw 浪费

#### 1.A FrameScheduler 模块（基础设施）

**新文件** `src/app/frameScheduler.ts`：

```ts
const MIN_FRAME_INTERVAL_MS = 50;  // 20FPS（ink 不像 ratatui 能跑 120）

class FrameScheduler {
  private lastEmittedAt = 0;
  private pendingTimer: NodeJS.Timeout | null = null;
  private pendingActions = new Map<string, () => void>();

  /** schedule(key, action): 同 key 后到的 action 覆盖前者，多 key 合并到下一帧 */
  schedule(key: string, action: () => void): void {
    this.pendingActions.set(key, action);
    if (this.pendingTimer) return;

    const now = Date.now();
    const earliest = this.lastEmittedAt + MIN_FRAME_INTERVAL_MS;
    const delay = Math.max(0, earliest - now);

    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.lastEmittedAt = Date.now();
      const actions = Array.from(this.pendingActions.values());
      this.pendingActions.clear();
      // React 18 自动 batch 这批 setState
      for (const action of actions) action();
    }, delay);
  }

  /** 测试用：立即冲刷，不等 timer */
  flushNow(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    const actions = Array.from(this.pendingActions.values());
    this.pendingActions.clear();
    for (const action of actions) action();
  }
}

export const frameScheduler = new FrameScheduler();
```

#### 1.B Newline-gated commit + partial line throttle

**改 `src/app/App.tsx`**（`message-delta` 那块）：

```ts
// 每个 message 的 partial line buffer（最后一行还没换行的部分）
const partialBuf = useRef(new Map<string, string>());
// committed text 增量 buffer（含换行的部分，等待批量推到 messages）
const committedBuf = useRef(new Map<string, string>());

if (event.type === "message-delta") {
  const id = event.messageId;
  const partial = (partialBuf.current.get(id) ?? "") + event.delta;
  const lastNewline = partial.lastIndexOf("\n");

  if (lastNewline === -1) {
    // 没换行：纯累积到 partial，不立即 setState；
    // 但低频率推到 UI 让用户看到"打字效果"（100ms 节流，schedule key 区分）
    partialBuf.current.set(id, partial);
    frameScheduler.schedule(`partial-${id}`, () => {
      setMessages(current => current.map(m =>
        m.id === id ? { ...m, text: getCommittedText(id) + partialBuf.current.get(id)! } : m
      ));
    });
  } else {
    // 含换行：把换行前的部分 commit，换行后剩余进 partial
    const toCommit = partial.slice(0, lastNewline + 1);
    const newPartial = partial.slice(lastNewline + 1);
    committedBuf.current.set(id, (committedBuf.current.get(id) ?? "") + toCommit);
    partialBuf.current.set(id, newPartial);
    // 立即 commit（仍走 frameScheduler 50ms 合并）
    frameScheduler.schedule(`commit-${id}`, () => {
      const committed = committedBuf.current.get(id) ?? "";
      committedBuf.current.set(id, "");
      setMessages(current => current.map(m =>
        m.id === id
          ? { ...m, text: m.text + committed + (partialBuf.current.get(id) ?? "") }
          : m
      ));
    });
  }
  continue;
}
```

**为什么不是简单的 50ms 节流**（来自 §10 交叉验证）：

LM Studio 30 tok/s × 平均每行 30-40 token ≈ **1 行/秒**。简单 50ms 节流仍然 20Hz setState，整 messages 数组重建 20 次/秒。**按换行 commit 之后**：

- "commit" 路径：~1 Hz setState（每秒约 1 次完整行 commit）
- "partial" 路径：~10 Hz setState（用户感知的打字效果，但每次只是末尾几字符变化）

**总 setState 频率从 30Hz 降到 11Hz**，**整树 reconcile 次数减半**。

**对应 codex**：
- `streaming/controller.rs:57 push_delta`：仅在 delta 含 `\n` 时 commit
- `streaming/mod.rs StreamState`：committed lines + active partial 分离
- 简化版本：codeclaw 不引入 FIFO 队列（直接 setState），但保留 newline-gated 这一核心约束

**风险**：低-中
- 改动局限于 App.tsx + 新文件
- `partialBuf` 与 `committedBuf` 必须在 message-complete / turn-end 时清理
- 流式开始前 messages 里要先有这条 message（message-start 必须在 message-delta 前到达，已经如此）

**测试策略**：
- 单测 frameScheduler.ts：连续 30 次 schedule 同 key，flushNow 后只有 1 次 action 执行
- 单测 frameScheduler.ts：50ms 内多次 schedule 不同 key，timer fire 时一起执行
- 单测 message-delta handler：100 个无换行 token 之后 setState ≤ 10 次
- 单测 message-delta handler：50 个含换行 chunk → committed text 拼接 = 输入拼接
- 集成测 App.tsx：模拟混合换行/不含换行的 message-delta 序列 30 个，最终 messages 文本与 raw 拼接一致，setState 调用次数 ≤ 输入事件数 / 3
- 真测（用户 Mac）：跑 LLM 长任务 30 分钟，看是否还死

**预期效果**：单步消除 80%+ 现象。如果做完 Phase 1 用户 Mac 上不再死，Phase 2-4 视情况推后。

**工作量**：1.5 天（比原方案多半天，因为 partial/committed 双 buffer 逻辑要谨慎处理 message-complete 边界）

---

### Phase 2 — subscribe diff 节流

**目标**：消除 queryEngine.subscribe 触发的冗余 setState

**改 `src/app/App.tsx:162-168`**：

```ts
useEffect(() => {
  let lastRuntime = queryEngine.getRuntimeState();
  let lastApproval = queryEngine.getPendingApproval();
  return queryEngine.subscribe(() => {
    frameScheduler.schedule("subscribe-runtime", () => {
      const next = queryEngine.getRuntimeState();
      if (next !== lastRuntime) {
        lastRuntime = next;
        setRuntimeState(next);
      }
      const ap = queryEngine.getPendingApproval();
      if (ap !== lastApproval) {
        lastApproval = ap;
        setPendingApproval(ap);
      }
      // messages 完全交给 stream loop 管，subscribe 不重复 setState
    });
  });
}, [queryEngine]);
```

**对应 codex**：codex 没有这个具体问题（Rust 闭包模型下 widget 自己管 dirty flag），但 codeclaw 现在的"全量 setState"是 React 模式下的过度反应。

**风险**：中
- `queryEngine.getMessages()` 不再 subscribe 触发 → 必须确认所有 messages 变化都来自 stream loop
- 排查点：autoCompact / 错误注入消息 / restoreFromMemory 等非流式路径是否覆盖

**测试策略**：
- 集成测：autoCompact 触发后 messages 仍能更新到 UI
- 真测：长对话触发 compact 后 UI 不丢消息

**工作量**：半天

---

### Phase 3 — stdout backpressure 检测

**目标**：彻底治根，让终端处理不过来时 codeclaw 主动暂停 yield

**改 `src/agent/queryEngine.ts`**（每个 yield event 之前）：

```ts
async function waitForStdoutDrain(auditEvent: (e: AuditEvent) => void): Promise<void> {
  // Node 22+ 才有 writableNeedDrain；老版本 fallback 到 writable 检查
  const stdout = process.stdout as NodeJS.WriteStream & { writableNeedDrain?: boolean };
  if (!stdout.writableNeedDrain) return;

  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const onDrain = () => {
      clearInterval(stallTimer);
      const waitedMs = Date.now() - startedAt;
      if (waitedMs > 1_000) {
        auditEvent({ actor: "engine", action: "stream.backpressure-cleared", waitedMs });
      }
      resolve();
    };
    stdout.once("drain", onDrain);
    // 每 5 秒发一次 stall 警告但不放弃等待（codex 没有兜底，我们也不该 silently 跳过）
    const stallTimer = setInterval(() => {
      const waitedMs = Date.now() - startedAt;
      auditEvent({
        actor: "engine",
        action: "stream.backpressure-stalled",
        waitedMs,
        reason: `stdout drain not fired in ${waitedMs}ms; terminal may be hung`
      });
    }, 5_000);
  });
}

// 在 submitMessage 的 yield 之前调一次
await waitForStdoutDrain(this.audit.bind(this));
yield event;
```

**对应 codex**：Rust 同步 io::Write + crossterm 的 buffered backend 天然处理反压（write 阻塞调用方）。Node 异步流必须主动检测。

**§10 交叉验证调优**：原方案 5 秒兜底 silently 跳过 → 改为 5 秒间隔发 stall 警告 + 持续等待。理由：
- 终端真死了，跳过去 yield 也写不出
- 用户层应该看到 "stream stalled" 提示而不是 silently 累积更多 stuck token
- 等用户主动 Ctrl+C 中断（codeclaw 已有 interrupt 机制）

**风险**：中
- 终端永久死掉时进程会 hang（但比 OOM 好；用户可 kill）
- 可能导致 LLM stream 与 UI 渲染轻微不同步（用户看到的 token 落后实际响应几十 ms）
- 需要小心 stdin 也用 process.stdout 的语义

**测试策略**：
- 单测：mock writableNeedDrain=true，verify yield 被延后
- 集成测：构造一个慢消费者（手动 setTimeout 不读 stdout），verify codeclaw 不 OOM
- 真测：模拟终端冷负载（拷大文件 + LLM 长任务），看 codeclaw 是否优雅降速

**工作量**：2 天

---

### Phase 4 (可选) — Synchronized Output 协议

**目标**：终端层渲染原子性，避免画到一半

**实现路径 A**（monkey-patch process.stdout.write）：

```ts
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: any, ...rest: any[]) => {
  return origWrite(`\x1b[?2026h${chunk}\x1b[?2026l`, ...rest);
}) as any;
```

但这会把每个 chunk 都包成"sync update"，开销大。

**实现路径 B**（fork ink，在 reconciler 边界包裹）：

ink 5 在 reconciler.js 提交一帧时调 onImmediateRender → log-update.js 调 stdout.write。在那一层加包裹：fork ink 或 patch-package。

**对应 codex**：`stdout().sync_update(...)` 的等价（§2.4）

**风险**：高
- monkey-patch 全局污染，可能影响 spawn 的 child process
- fork ink 维护成本高
- patch-package 升级 ink 时容易丢

**条件**：仅在 Phase 1-3 都做完后，用户 Mac 仍有终端渲染问题才做。

**工作量**：1-2 天（路径 B 包含 ink fork 设置）

---

## 4. 实施顺序与决策

### 4.1 渐进式 ship 原则

每个 Phase 独立 commit + 独立 tag + 独立验证。**不允许 Phase 1+2 一起 ship 再调试**。

```
v0.8.3 (现状)
  ↓
v0.8.4 = Phase 1 (FrameScheduler) → 用户 Mac 真测 30 分钟
  ↓ 仍死
v0.8.5 = Phase 2 (subscribe diff) → 真测
  ↓ 仍死
v0.9.0 = Phase 3 (backpressure) → 真测
  ↓ 仍有渲染问题
v0.9.x = Phase 4 (sync update) → 真测
```

### 4.2 决策点

每个 Phase ship 后，**用户 Mac 跑一次 30 分钟 LLM 长任务真测**。判定条件：

| 现象 | 判定 |
|---|---|
| 终端不死、crash.log 无新增 | Phase 已修复，停止后续 Phase |
| 终端死、crash.log < 100KB | Phase 部分见效，继续下一个 |
| 终端死、crash.log > 1MB | Phase 完全没用，回滚并重新分析 |

### 4.3 ROI 排序

| Phase | 工作量 | 预期消除现象比例 | ROI |
|---|---|---|---|
| 1 (newline-gated) | 1.5 天 | 80%+ | ⭐⭐⭐⭐⭐ |
| 2 (subscribe diff) | 半天 | 5% | ⭐⭐⭐ |
| 3 (backpressure) | 2 天 | 14% | ⭐⭐⭐⭐ |
| 4 (sync update) | 1-2 天 | 1% | ⭐ |
| §10.5 (adaptive chunking 大重构) | 5-7 天 | 完全对齐 codex | ⭐⭐ (仅 1-4 不够时考虑) |

**强烈建议**：Phase 1 先单独 ship。如果 Phase 1 单步消除 ≥ 80%，**Phase 2-4 全部推后或不做**。

---

## 5. 不在范围内（显式排除）

- ❌ **替换 ink**：完全重写 UI 层，工作量级 2-4 周，风险极高
- ❌ **重写 React tree 结构**：当前 App.tsx tree 没问题，是渲染频率问题
- ❌ **改 LLM stream 协议**：`message-delta` 这种事件设计是对的，节流应该在 UI 层
- ❌ **改 queryEngine 内部 notifyListeners 时机**：Phase 2 已通过订阅方过滤解决，不动 publisher
- ❌ **fork crossterm/ratatui 翻译到 TS**：codex 用 Rust，TS 没必要走这条路
- ❌ **加 Web UI 替代 CLI**：已有 `codeclaw web` 子命令，跟 CLI 渲染节流是独立问题

---

## 6. 风险与回滚

### 6.1 整体回滚

每个 Phase 是独立 commit。如果某 Phase ship 后引入 regression：

```bash
git revert <phase-commit>
```

不需要重新发版本，下一个补丁 commit 即可。

### 6.2 已知潜在风险

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| Phase 1 50ms 延迟在用户感知层"卡顿" | 极快 LLM 流式（>40 tok/s）+ 用户对延迟敏感 | 50ms 接近人类感知阈值；可降到 33ms（30FPS）作回退 |
| Phase 2 messages 不再 subscribe 推 → 漏更新 | autoCompact / 异步 message 注入路径 | grep `notifyListeners` 全部 18 处审查后再改 |
| Phase 3 backpressure 5 秒兜底掩盖真问题 | 终端真死了但 yield 继续 | 加 audit log 记录每次 wait 超时，便于事后分析 |
| Phase 4 sync update 字节序列与某些 terminal 不兼容 | 老版本终端不识别 `\x1b[?2026h` | 检测终端能力（terminfo / `$TERM_PROGRAM`），不支持就降级 |

---

## 7. 测试策略汇总

### 7.1 单元测试

- `test/unit/app/frameScheduler.test.ts`（新）
  - schedule 同 key 多次 → flush 后只 1 次 action
  - schedule 多 key → flush 后所有 action 都执行
  - 50ms 内多次 schedule → 只一次 timer fire
  - flushNow 立即触发，清空 pending

- `test/unit/agent/queryEngine.test.ts`（扩）
  - Phase 3 加：mock writableNeedDrain=true，yield 延后
  - Phase 3 加：5s 兜底超时正确触发

### 7.2 集成测试

- `test/integration/app/render-throttle.test.ts`（新）
  - 模拟 30 个 message-delta event，verify final messages text + setState 次数 ≤ 输入数 / 2

### 7.3 真测（用户 Mac）

每个 Phase ship 后跑：

```bash
caffeinate -dimsu node dist/cli.js
# 提一个长问题让 LM Studio 27B 跑 ≥ 30 分钟
# 离开 ≥ 10 分钟无输入
# 回来检查：终端是否仍可交互、crash.log 体积、ps aux | grep node
```

判定标准见 §4.2。

---

## 8. 附录：当前现场数据汇总

### 8.1 v0.8.3 已修部分

- ✅ probe 远程 baseUrl 跳检（lmstudio 假失败 bug）
- ✅ streaming buffer 32MB 上限（防 OOM 治根之一）
- ✅ EIO/EPIPE 立即退出（防死循环 11MB crash.log）

### 8.2 v0.8.3 仍未覆盖

- ❌ 高频 setState 导致 pty buffer 反压（本 RFC 治根目标）
- ❌ 10 分钟无输入终端死（已实测 Ghostty 也复现）

### 8.3 关键代码位置（治理对象）

| 位置 | 问题 | 治理 Phase |
|---|---|---|
| `src/app/App.tsx:309-316` | 每 token setMessages | Phase 1 |
| `src/app/App.tsx:162-168` | subscribe 全量 3 次 setState | Phase 2 |
| `src/agent/queryEngine.ts:*` (18 处) | yield event 不检查反压 | Phase 3 |
| `node_modules/ink/build/log-update.js` | 直接 stdout.write，无 sync update | Phase 4 |

### 8.4 关键现场指纹

| 现场 | 数据 |
|---|---|
| 02:40 OOM 那次 | 11MB crash.log, 14000 条 EIO, 56 分钟运行, 4GB 堆爆 |
| 09:14-10:07 那次 | 53 分钟间歇 EIO, 进程未崩 |
| 18:07 Ghostty 死那次 | 26KB crash.log, 30 条 EIO 5 秒内, 终端 hang 无 crash report |

---

## 10. 交叉验证发现（参考 codex 第二轮深挖 + Claude Code inference）

### 10.1 检索路径

第一轮 RFC 仅检索了 `codex-rs/tui/src/tui/`（frame_rate_limiter / frame_requester），漏掉 **`codex-rs/tui/src/streaming/`** 整个模块。第二轮深挖发现：

- `streaming/mod.rs` `StreamState` — 含时间戳的 `queued_lines: VecDeque<QueuedLine>`
- `streaming/controller.rs` `push_delta` — **delta 含 `\n` 才 commit**（核心约束）
- `streaming/chunking.rs` `AdaptiveChunkingPolicy` — 双档 + hysteresis 防抖
- `streaming/commit_tick.rs` — 把 chunking 决策应用到 controller drain

Claude Code 闭源（`@anthropic-ai/claude-code` npm 包 minified），无法做源码对照；相关推断从行为表现 inference。

### 10.2 codex 实际 streaming 设计（RFC v1 漏掉的层级）

```
LLM token → MarkdownStreamCollector
   ↓ (newline-gated: 只在 \n 处 commit)
完整一行 → StreamState.queued_lines (FIFO + enqueued_at)
   ↓
commit tick (frame requester 触发) + AdaptiveChunkingPolicy.decide()
   ↓
Smooth mode: 1 行/tick     ← 队列不堆积
CatchUp mode: 全部 drain   ← 队列 ≥ 8 行 OR 最老 ≥ 120ms
   ↓
ratatui render
```

关键参数（`streaming/chunking.rs:85-116`）：

```rust
const ENTER_QUEUE_DEPTH_LINES: usize = 8;    // 进 catch-up 阈值（队列深度）
const ENTER_OLDEST_AGE: Duration = 120ms;    // 进 catch-up 阈值（最老行年龄）
const EXIT_QUEUE_DEPTH_LINES: usize = 2;     // 出 catch-up 阈值
const EXIT_OLDEST_AGE: Duration = 40ms;
const EXIT_HOLD: Duration = 250ms;           // 退出后 hold 时间防抖
const REENTER_CATCH_UP_HOLD: Duration = 250ms;
const SEVERE_QUEUE_DEPTH_LINES: usize = 64;  // 严重情况强制 catch-up
const SEVERE_OLDEST_AGE: Duration = 300ms;
```

### 10.3 Claude Code inference（无源码佐证）

仅基于使用观察的推测：

| 行为 | 推测内部机制 | 与 codex 对照 |
|---|---|---|
| 长流式响应不撑死终端 | 可能也用 newline-gated 或类似批量提交 | 趋同 |
| idle 时几乎零 redraw | 可能没有持续动画 / spinner 完全静止 | 趋同 |
| 终端 resize 平滑 | 类似 75ms debounce | 趋同 |
| 大段代码块输出快 | 可能识别 fenced code 整体 commit，不按行 | 比 codex 更激进 |

**结论**：CC 的设计大概率与 codex 在同一思想下，两者实测都不出现 codeclaw 现在的现象。

### 10.4 RFC 调优清单（已合并入正文）

| 调优点 | 原 RFC v1 设计 | 调优后设计 | 章节 |
|---|---|---|---|
| **Phase 1 节流方式** | 50ms 简单节流 | newline-gated + partial line 节流 | §3.1 |
| **Phase 1 setState 频率** | ≤ 20Hz | commit ~1Hz + partial ~10Hz = ~11Hz | §3.1 |
| **Phase 1 工作量** | 1 天 | 1.5 天 | §3.1 |
| **Phase 3 backpressure 兜底** | 5 秒 silently 跳过 | 5 秒间隔 stall 警告 + 持续等待 | §3.3 |
| **Adaptive chunking**（新增 v0.10+ 选项） | — | 仿 codex 双档 + hysteresis（推后到大重构） | §10.5 |

### 10.5 推后到 v0.10+ 的重构选项

完整对齐 codex 架构（**不在本 RFC 范围内**）：

1. **MarkdownStreamCollector** TS 等价物：处理 incomplete fenced code / lists / 嵌套 markdown 的 commit 时机
2. **FIFO 行队列 + 时间戳**：不直接 setState，先入队再按 commit tick 出队
3. **AdaptiveChunkingPolicy 双档**：Smooth / CatchUp + 滞后切换（§10.2 参数）
4. **CommitTick 独立 ticker**：与 frame request 分层（commit tick 触发"几行入 messages"，frame request 触发"画一帧"）
5. **per-stream controller**：message / plan / 思考过程（reasoning）用不同 commit 策略

工作量估计：**5-7 天**，重写 message rendering 数据流。

**触发条件**：仅在 Phase 1-4 全做完后用户 Mac 仍有渲染问题才考虑。

---

## 11. 决策清单（用户拍板）

⚠️ §11 是原 §9，因 §10 插入而重编号

请回复：

1. **是否同意 RFC 整体方向**？
2. **是否同意 §10 调优清单的 Phase 1 升级**（newline-gated commit 替代简单 50ms 节流）？这是与原方案的最大差异。
3. **是否先做 Phase 1**（单步 ship 验证）？
4. **是否同意 §5 排除项**（特别是不替换 ink）？
5. **是否同意 §10.5 推后**（adaptive chunking 大重构仅在 Phase 1-4 不够时再做）？
6. **真测 30 分钟运行的 LLM 长任务，具体跑什么**？（需要可复现的 prompt 或脚本）

确认后开始 Phase 1 实施。

请回复：

1. **是否同意 RFC 整体方向**？
2. **是否先做 Phase 1**（单步 ship 验证）？
3. **是否同意 §5 排除项**（特别是不替换 ink）？
4. **真测 30 分钟运行的 LLM 长任务，具体跑什么**？（需要可复现的 prompt 或脚本）

确认后开始 Phase 1 实施。
