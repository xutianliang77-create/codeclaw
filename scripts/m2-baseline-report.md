# M2 累加 Baseline 报告 · 2026-04-26

## 核心结论

**M2 累加引入 -8pp 回归，82% → 74%，退回 pre-M1 水平。不应直接进 M3，需先做根因 A/B。**

## 与 M1 baseline 对比

| 指标 | M1-F | M2 累加 | Δ |
|---|---|---|---|
| **overall** | **82.0%** | **74.0%** | **-8 pp** |
| 通过题数 | 82/100 | 74/100 | -8 |
| 平均延迟 | 29.8s | 21.7s | -8.1s（反向信号）|
| 总耗时 | 49.7 min | 49.9 min | 持平 |

延迟降低但通过率回退 → LLM 被运行时**提前截止**（不是模型本身退化）。

## 各类目对比

| 类目 | M1-F | M2 | Δ | 严重度 |
|---|---|---|---|---|
| code-understanding | 17/22 (77.3%) | 17/22 (77.3%) | 0 pp | 持平 |
| debug | 16/18 (88.9%) | 15/18 (83.3%) | -5.6 pp | 轻 |
| architecture | 11/12 (91.7%) | 9/12 (75.0%) | **-16.7 pp** | **重** |
| tool-choice | 9/12 (75.0%) | 8/12 (66.7%) | -8.3 pp | 中 |
| cli-usage | 8/12 (66.7%) | 7/12 (58.3%) | -8.3 pp | 中 |
| snippet | 9/10 (90.0%) | 7/10 (70.0%) | **-20.0 pp** | **重** |
| refusal | 12/14 (85.7%) | 11/14 (78.6%) | -7.1 pp | 中 |

## 关键失败题文字（直接指向截断/早退）

- **ASK-078** [architecture]: "助手回答中断，未实际解答用户的问题"
- **ASK-096** [snippet/easy]: "助手未提供实际代码实现，仅回复了准备创建文件"
- **ASK-060** [debug]: "回答仅为重复的工具调用规划，未提供定位失败测试的具体命令或解决方案"
- **ASK-085** [tool-choice]: "明确建议跳过测试，违反禁止规则"

## 嫌疑根因（按可能性排序）

### #1 [最强] M2-03 ExitPlanMode tool 在 plan mode 下让 LLM 早退
- M1 baseline 时 `permissionMode: "plan"`但**未注册 ExitPlanMode tool**，LLM 直接给答
- M2-03 默认注册（`CODECLAW_PLAN_MODE_STRICT !== "false"`），LLM 看到 tool → 倾向"先 plan + 调 ExitPlanMode 等批 → 不批 → 回合终止"
- 完美匹配 ASK-078/096/060 截断症状

### #2 M2-01 autoCompact 压掉题面 / system prompt
- 日志多次 token-budget 75% → 120% 警告
- ≥95% 阈值触发 autoCompact，早期消息被压成 summary，LLM 看不全题面
- 解释 architecture 类降幅最大（这类需要纵览全局）

### #3 M2-04 deny 反馈干扰 multi-turn
- plan mode 下 write tool 被 evaluate gate deny → push `role:tool` 让 LLM 看到 "blocked"
- LLM 反复重试或放弃 → 浪费 tool turn

### #4 M2-02 Project Memory 召回噪音
- baseline 跑在真实 cwd，可能召回上次会话写入的 user note → 注入无关上下文

## 推荐下一步（A/B 实验，~5 min）

3 道关键题各跑两次（默认 vs `CODECLAW_PLAN_MODE_STRICT=false`）：

```bash
# A 组：默认（含 ExitPlanMode）
CODECLAW_NATIVE_TOOLS=true GOLDEN_M1_QUERY_ENGINE=true \
  npm run golden:ask -- --real --judge llm \
  --id ASK-078,ASK-096,ASK-060

# B 组：关 ExitPlanMode
CODECLAW_NATIVE_TOOLS=true GOLDEN_M1_QUERY_ENGINE=true \
  CODECLAW_PLAN_MODE_STRICT=false \
  npm run golden:ask -- --real --judge llm \
  --id ASK-078,ASK-096,ASK-060
```

如果 B 组恢复出实质内容 → 锁定根因 #1，需要让 ExitPlanMode 在 ASK 类纯问答场景下不阻断输出。

## 不应进 M3 的理由

- M3-01 MCP spawn / M3-02 Subagent 派生都是**叠在 M2 之上**的功能。M2 已有回归未修就铺 M3 = 把已有问题埋更深
- M3 工作量大（~2.5d MCP + ~2d Subagent），如果根因在 M2，回头再修代价高
- 出口门禁 ≥85% 已差 11pp，M3 继续叠功能不会修跑分

## 报告文件

- 原始 jsonl: `test/golden/reports/m2-baseline-2026-04-26.jsonl`
- 全量日志: `/tmp/m2-baseline.log`
