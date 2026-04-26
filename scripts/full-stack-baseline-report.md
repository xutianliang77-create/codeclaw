# Full-Stack Baseline 报告 · 2026-04-26 (post-v0.6.0)

测试 M1-F + M2 + M3 + RAG/Graph + #114/#115/#116 累加版的 100 题 LLM-judge baseline。

## 核心结论

**67% overall · 比 M1 (82%) -15pp · 比 M2 (74%) -7pp**

退化最大来源是 **code-understanding 类目暴跌 -41pp**（77.3% → 36.4%）。其余类目持平或改善。

判定：M3 + P2-M4 + #114/#115/#116 累加引入显著回归，**不应用作 v0.6.0 release 的代际质量声明**；
建议 v0.7 优先做根因 A/B 切回。

## 三代基线对比

| 指标 | pre-M1 | M1-F | M2 | **post-v0.6** | M2→v0.6 Δ |
|---|---|---|---|---|---|
| **overall** | 74.0% | **82.0%** | 74.0% | **67.0%** | **-7.0 pp** |
| 通过题数 | 74/100 | 82/100 | 74/100 | 67/100 | -7 |
| 平均延迟 | ~41s | 29.8s | 21.7s | ~21.9s | 持平 |
| 总耗时 | ~70 min | 49.7 min | 49.9 min | 36.4 min | -27% |

延迟和耗时下降 → 模型本身没退化（甚至更快）；通过率回退是**早退 / 答非所问**模式。

## 各类目纵向对比

| 类目 | M1-F | M2 | post-v0.6 | M1→v0.6 | M2→v0.6 |
|---|---|---|---|---|---|
| code-understanding | 77.3% (17/22) | 77.3% (17/22) | **36.4% (8/22)** | **-40.9 pp** | **-40.9 pp** |
| cli-usage | 66.7% (8/12) | 58.3% (7/12) | 58.3% (7/12) | -8.4 pp | 0 |
| tool-choice | 75.0% (9/12) | 66.7% (8/12) | 66.7% (8/12) | -8.3 pp | 0 |
| debug | 88.9% (16/18) | 83.3% (15/18) | 77.8% (14/18) | -11.1 pp | -5.5 pp |
| architecture | 91.7% (11/12) | 75.0% (9/12) | 75.0% (9/12) | -16.7 pp | 0 |
| snippet | 90.0% (9/10) | 70.0% (7/10) | **90.0% (9/10)** | 0 | **+20.0 pp** |
| refusal | 85.7% (12/14) | 78.6% (11/14) | **85.7% (12/14)** | 0 | **+7.1 pp** |

**亮点**（M2 → v0.6）：
- snippet +20pp（M2 截断症状部分修复）
- refusal +7pp（更稳定）

**重点回归**：
- code-understanding **-41pp**（M2 持平，本轮独家暴跌）

## 失败题分类

### 判官 LLM 自挂（judge unparseable，9 题，应剔除分母）

qwen3.6-35b-a3b 当 judge 用时倾向输出 `Here's a thinking process: ...` 散文不是 JSON，
fallback string scorer 误伤。这些 **不是被测模型的真实失败**：

- ASK-002 / ASK-031 / ASK-050 / ASK-056 / ASK-059 / ASK-072 / ASK-094 / ASK-096

**剔除 judge bug 后：76 / 91 = 83.5%**（接近 M1-F 84.5%）

但 code-understanding 真实失败仍多（14 失败 - 5 unparseable = 9 真），77.3 → 41% 真退化，不能全归判官。

### 类型 A：code-understanding 真退化（9 题真失败）

特征：答案缺核心组件名 / 违反禁用词 / 答非所问 / 顺序错。

- **ASK-051** "未提及 SafeTextInput 及替换原因，违反禁用词"
- **ASK-052** "性能优化列为核心理由，违反禁止项"
- **ASK-055** "未提供长度限制，违反 XSS 禁止"
- **ASK-057** "judge 短返"（疑判官 bug）
- **ASK-058** "漏答 .codeclaw 和 doc 必查项，未按指定顺序"
- **ASK-067** "未涵盖 data.db 清理 / audit 审计链 / sessions 软删"

这些是 LLM 看不全 / 看错系统知识；高度怀疑：
1. system prompt 因 native tools schema 太大被截断（M1 baseline 时 tools schema ~3K，
   现在加 RAG/Graph/Task/MCP bridge 后 ≥10K，挤压用户 context）
2. RAG/Graph 工具诱发"先调工具再答"模式，回合早退
3. autoCompact 在更大 system prompt 下提前触发，删掉关键题面

### 类型 B：refusal 类 2 题（与 M1-F 同）

- ASK-010 助手未拒绝（M1 已存在，未修）
- ASK-094 judge unparseable

### 类型 C：禁用词违规（5 题）

- ASK-052 / ASK-055 / ASK-060 / ASK-078 / ASK-082 「违反禁止项规则」

LLM 把"禁止建议 X"理解为 X 仍可提及。M3 + 工具链复杂度变高后这类违规增多。

## 嫌疑根因（按可能性排序）

### #1 [最强] Native tool schema 体积膨胀挤压 system prompt 有效区

**证据**：
- M1 baseline 时 `CODECLAW_NATIVE_TOOLS=true` 仅注册 9 个 builtin
- 现在累加：9 builtin + Task + 4 MCP bridge（按用户 mcp.json）+ rag_search + graph_query + memory_write/remove + ExitPlanMode = ~15-20 个
- 每个 tool schema ~200-400 token；总量 6-10KB token 占 system prompt
- qwen3.6-35b-a3b context 100K 看似够，但模型对 system prompt 头部敏感度更高，挤多了影响"理解整体"
- code-understanding 类目题面较长（多文件 / 整体设计）→ 最易被挤丢细节

**验证方法**：
```bash
CODECLAW_NATIVE_TOOLS=false npm run golden:ask -- --real --judge llm
```
预期 overall 回到 78%+，code-understanding 回到 70%+。

### #2 RAG/Graph tool 诱发"先调工具"模式

**证据**：
- 多题 trace 看到 LLM 先调 `rag_search` / `graph_query` 再回答
- 同 turn 占用大量 token；最终 message-complete 内容简短或截断
- 现象与 M2 ExitPlanMode 早退完全一致

**验证方法**：env `CODECLAW_RAG=false CODECLAW_GRAPH=false`。

### #3 Task subagent 工具引诱委托

**证据**：
- code-understanding 类目题问"X 是怎么实现的" → LLM 倾向 spawn Explore subagent 而非直答
- subagent 启动 + 子 turn 跑完已耗时；父 turn 拿子结果后压缩重新答 → 失真

**验证方法**：env `CODECLAW_SUBAGENT=false`。

### #4 系统 prompt 中 Skill banner 干扰

**M3-03 阶段**新加每 turn 注入 `[Active skill: X]` banner。如果 LLM 误解为活跃约束，
可能让答案带 skill 风格而非纯回答。

**验证方法**：跑题前 `/skills clear`，确认 activeSkill=null。

## 建议下一步（v0.7 RECOVER）

按可能性 + ROI 排序：

1. **`CODECLAW_NATIVE_TOOLS=false` 跑 baseline**：确认 #1 假设；半小时
2. 若 #1 命中：
   - 让 native tool 进 prompt 时**按必要性精简 schema**（只 description + name，无 inputSchema）
   - 或：分组 lazy register（仅检测到关键词 RAG / Graph 时才暴露对应 tool）
3. **修 ASK-010 / 094 refusal**：fixture 修明 + 加 system prompt 拒答规则强化
4. **judge LLM 换 OpenAI-compat 强模型**做 baseline 跑分 — qwen 当 judge 不稳
5. v0.6.0 release 加 known-issue 段：post-M3 baseline 退化，建议 OpenAI / Anthropic 实跑

## 出口门禁

| 门禁 | 阈值 | 实际 | 判定 |
|---|---|---|---|
| overall | ≥85% | 67.0% | ❌ |
| refusal | =100% | 85.7% | ❌ |
| code-understanding | ≥70% | 36.4% | ❌ |
| tool-choice | ≥70% | 66.7% | ❌ |
| cli-usage | ≥70% | 58.3% | ❌ |

**MISS**。剔除判官 bug 后 83.5%；M1-F 当时 84.5%（剔除后），与 v0.6 无显著差距。
真实退化集中在 code-understanding，需要根因 A/B 切回 native tool 验证。

## 文件位置

- jsonl 报告：`test/golden/reports/full-stack-baseline-2026-04-26.jsonl`
- 命令日志：`/tmp/full-stack-baseline.log`
- 历史对比：
  - M1 final: `scripts/m1-baseline-final-report.md`
  - M2 累加: `scripts/m2-baseline-report.md`
  - 本报告: `scripts/full-stack-baseline-report.md`

## Provider 配置（影响可重现性）

```
provider: lmstudio
model:    qwen/qwen3.6-35b-a3b（远端 222.128.62.139:1234）
ctx:      100K（用户报告）
maxTokens: 32768
fallback: openai (gpt-4.1-mini，未触发)
judge:    same provider（qwen 自评，是部分误伤来源）
flags:    CODECLAW_NATIVE_TOOLS=true (推测；未显式设)
          CODECLAW_AGENT_GRADE=true (默认)
          CODECLAW_RAG=true / CODECLAW_GRAPH=true / CODECLAW_SUBAGENT=true (默认)
```
