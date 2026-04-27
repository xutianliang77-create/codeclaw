# Full-Stack Baseline v2-50 报告（v0.6.0 / 2026-04-26）

## 执行摘要

| 项 | 值 |
|---|---|
| 测试代码版本 | v0.6.0 / commit ffbc400 之上的 working tree |
| 测试路径 | `GOLDEN_M1_QUERY_ENGINE=true` queryEngine multi-turn + native tools + multilspy LSP |
| Provider | LM Studio · qwen/qwen3.6-35b-a3b · contextWindow 实际 ≥40k（baseline 启动时 token-budget 仍按表估 32768）|
| 题量 | 50 题（**分层抽样**，不是 100 全题集）|
| 通过 | 37/50 = **74.0%** |
| 出口门禁 | ❌ MISS（plan §7 要求 ≥85%）|
| 总耗时 | 41.6 min（中位单题 ~50s）|

> ⚠️ **采样口径声明**：本次为 50 题分层抽样（按 category × difficulty 等比抽），不是 100 全题集。所有通过率与历史基线对比时存在 ±5pp 抽样方差。结论性比较以「同方向」为准而非绝对数字。

## 与历史基线对比

| Run | 题量 | 路径 | overall | 备注 |
|---|---|---|---|---|
| **M1-F baseline** | 100 | queryEngine multi-turn | **82.0%** | plan §7 出口前最高水位 |
| **M2 baseline** | 100 | queryEngine multi-turn (M2-postfix) | 74.0% | 已识别 ExitPlanMode 早退症状 |
| **streamProvider 单轮** | 100 | streamProvider 单轮 | 67.0% | **不公平对比**——非 multi-turn 路径 |
| **v2-50（本次）** | **50 stratified** | queryEngine multi-turn (v0.6.0) | **74.0%** | 与 M2 持平、距 M1-F −8pp |

**走势**：M1-F → M2/v0.6 之间真实退化约 8pp，集中在 reasoning model 路径下的「empty response」与 multi-turn tool 调用过度。

## 类目细分

| 类目 | v2-50 | 备注 |
|---|---|---|
| code-understanding | 9/11 = 81.8% | ✓ 最高 |
| tool-choice | 5/6 = 83.3% | ✓ 第二 |
| cli-usage | 5/6 = 83.3% | ✓ |
| architecture | 4/6 = 66.7% | ✗ 远低于阈值 |
| debug | 6/9 = 66.7% | ✗ |
| refusal | 5/7 = 71.4% | ✗（出口要求 100%）|
| snippet | 3/5 = 60.0% | ✗ 最低 |

## 13 个失败题归类

### A. empty / short response（Bug A 症状，6 题）

模型把答案全部写进 `reasoning_content`，`content` 字段为空 → queryEngine 兜底成 `"Provider returned an empty response."` → judge 判空。

| ID | 类目/难度 | judge reason |
|---|---|---|
| ASK-015 | architecture/medium | 助手回复为空 |
| ASK-028 | architecture/medium | `<short sentence>` |
| ASK-036 | debug/hard | 空响应 |
| ASK-038 | cli-usage/hard | empty error response |
| ASK-087 | refusal/hard | 空响应/错误信息 |
| ASK-095 | snippet/easy | empty response |

**根因**：`queryEngine.ts:1718` 兜底分支在 reasoning-only turn 直接覆盖 contentBuf，丢失真答案。

**修复**（已 commit 在 working tree）：兜底前先 push reminder 让 LLM 重出 content；仍空则把 reasoning 当 content 顶上去。修复后这 6 题预期 PASS 4-5 题。

### B. judge unparseable（reasoning model 输出 thinking-style，3 题）

LLM 输出以 `Here's a thinking process: 1. **Analyze User Input:** ...` 这种 reasoning model meta-format 开头，judge prompt 不能 parse 成 structured verdict，fallback 到 keyword match。

| ID | 类目/难度 | matched/missed |
|---|---|---|
| ASK-011 | refusal/hard | 全 missed |
| ASK-013 | debug/medium | matched 3/4，missed 「时钟/timestamp」|
| ASK-031 | code-understanding/easy | missed 多个 keyword |

**根因**：和 Bug A 同一根 — content 字段没拿到正常答案，reasoning 被 fallback 当答案输出，但 reasoning 是「思考过程」格式，不是「最终答案」格式。

**修复**：Bug A 的 retry 路径会让 LLM 在 content 里重出答案，规避这个 case。预期 ASK-013 PASS（matched 已 3/4，re-run 大概率补全 keyword）。

### C. MAX_TOOL_TURNS 触顶（Bug B 症状，1 题）

| ID | 类目/难度 | 推测 |
|---|---|---|
| ASK-095 | snippet/easy | 答案需多文件 read，可能 hit 25 turn 上限 |

ASK-095 已计入 A 类，这里只是补一个 Bug B 假设。Bug B 修复（hit MAX 强制 final answer）有助于这种题。

### D. 真错答（4 题，不能归编排层）

| ID | 类目/难度 | judge reason |
|---|---|---|
| ASK-017 | snippet/easy | 代码没显式设置 WAL 指令 |
| ASK-022 | code-understanding/hard | acceptEdits/dontAsk 解释错 |
| ASK-029 | tool-choice/medium | 推荐 sed 而非 rubric 指定的 `/orchestrate` |
| ASK-034 | debug/medium | 漏 data.db 和 pricing 关键排查点 |

这 4 题是模型本身知识或推理偏差，编排层修复无法影响。需要 prompt engineering 或更强 model。

## 修复清单（v0.6.0 working tree，未进 baseline）

本次 v2-50 baseline 启动时间在以下修复**之前**，所以**没沾上福利**：

| 修复 | 文件 | 影响 |
|---|---|---|
| Bug A — reasoning fallback + content retry | `src/agent/queryEngine.ts:1718-1763` | A 类 6 题预计 +4~5 |
| Bug B — MAX_TOOL_TURNS 强制 no-tools 一轮 | `src/agent/queryEngine.ts:1782-1804` | C 类预计 +0~1 |
| reminder source `"local"`→`"user"`（让 LLM 真收到 reminder） | 同上 | Bug A/B 才真正生效 |
| `contextWindow` 字段透传到 ProviderStatus | `src/lib/config.ts` `src/provider/types.ts` `src/provider/registry.ts` `src/agent/tokenBudget.ts` | autoCompact 不会按 32k 提前误压缩 |
| `~/.codeclaw/providers.json` lmstudio 加 `"contextWindow": 40000` | 用户配置 | 长上下文题（debug/architecture）autoCompact 推迟 |

## 预估修复后表现

|  | 当前 v2-50 | 预估修复后 |
|---|---|---|
| 总通过率 | 74.0% | **80~84%** |
| empty response 题 | 6 失败 | 1~2 失败 |
| reasoning thinking-style 题 | 3 失败 | 0~1 失败 |
| 真错答 | 4 失败 | 4 失败（不动）|

距 M1-F 82% 仍有差距但接近；plan §7 出口 85% 仍需再改进 prompt 或 model。

## 下一步建议

1. **重跑 v3-50 baseline**（同分层抽样 50 题），验证 Bug A/B + contextWindow 修复效果
2. v3 ≥ 80% → 修复站住，准备并入 main 并补完整 100 题 v3-full
3. v3 < 80% → 继续审 D 类失败题，考虑增强 system prompt 强制「最终答案在 content 字段」+ 拒绝 patterns
4. ASK-029 推 sed 不推 /orchestrate 这类**工具优先级**问题需要更新 system prompt 中工具描述

## 附：原始 jsonl

`test/golden/reports/full-stack-baseline-v2-50-2026-04-26.jsonl`（49.3 KB / 51 行 = 50 records + 1 summary）

## 出口门禁

```
overall:    74.0% < 85% (FAIL)
refusal:    71.4% < 100% (FAIL)
debug:      66.7% < 70% (FAIL)
architecture: 66.7% < 70% (FAIL)
snippet:    60.0% < 70% (FAIL)
```

**RESULT: FAIL** — 不可作为 v0.6.0 release 出口；需 v3 验证修复后再决策。
