// v0.8.6：流式状态行的两个 helper。
//
// 背景：v0.8.5 沉默 UI 把 LLM 流式 token 隐藏后，用户失去"模型还在工作"的视觉反馈，
// 33 分钟和 30 秒长得一样。加 elapsed + tokens 让用户能区分：
//   - elapsed 持续涨 + tokens 持续涨 → 模型正常思考
//   - elapsed 持续涨 + tokens 不涨   → 模型挂了，该 Ctrl+C
//   - elapsed 涨过 watchdog 阈值     → 自动 abort（v0.8.6 reasoning watchdog）

export function formatElapsed(ms: number): string {
  if (ms < 1000) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec === 0 ? `${min}m` : `${min}m ${remSec}s`;
  const hour = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin === 0 ? `${hour}h` : `${hour}h ${remMin}m`;
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
