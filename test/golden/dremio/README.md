# Dremio MCP Golden Suite

20 道题端到端验证 codeclaw ↔ dremio-mcp ↔ Dremio OSS 链路，无需在 Dremio 里建任何表（全用 `INFORMATION_SCHEMA` / `sys.*` 系统资源 + `VALUES` 内联子查询）。

参考完整集成步骤：[docs/INTEGRATIONS-dremio-oss.md](../../../docs/INTEGRATIONS-dremio-oss.md)

---

## 题目分布

| Layer | 数量 | 验什么 | gate |
|---|---|---|---|
| **L1** Direct MCP | 7 | runner 直调 `mcpManager.callTool(server, tool, args)` — 验 transport / auth / 工具语义 | 100% |
| **L2** Natural Language | 10 | 真 LLM + 注入 mcpManager；验 (a) LLM 是否调对工具 (b) answer 是否含期望事实 | ≥ 80% |
| **E** Edge | 3 | 故意错的 SQL / 不存在的 tool / 大结果集 — 验 runner 不崩 | ≥ 66% |

总通过线：每层各达 gate 即整体 PASS。

---

## 在 Mac 上运行

### 一次性准备

1. 跑通 `docs/INTEGRATIONS-dremio-oss.md` 6 步（Dremio OSS docker + dremio-mcp + `~/.codeclaw/mcp.json`）
2. 启动 codeclaw 进 CLI 跑过 `/mcp tools dremio` 验证 7 个工具列出（不然 runner 启动也会失败）
3. 确认 `~/.codeclaw/providers.json` 有可用的 LLM provider（L2 题需要）
4. 确认 dremio session token 没过 24h（否则先 curl `/apiv2/login` 拿新的、改 `~/.config/dremioai/config.yaml`）

### 跑 suite

```bash
cd /path/to/codeclaw
npm install
npm run build       # 不强制；runner 走 tsx 不依赖 dist

# 全量
npm run golden:dremio

# 仅 schema 校验（不调 LLM/MCP）
npm run golden:dremio -- --dry-run

# 仅 L1（最快，纯 MCP 直调，~30s）
npm run golden:dremio -- --layer L1

# 仅 L2（最慢，每题 LLM 推理 ~40s，~7min）
npm run golden:dremio -- --layer L2

# 单题
npm run golden:dremio -- --id DRM-003 --verbose

# Mock 模式（不调 LLM/MCP，骨架自测）
npm run golden:dremio -- --mock --verbose
```

### Exit code

- `0` = gate pass（每层达标）
- `1` = gate fail（某层未达标）
- `2` = runner error（loader 失败 / provider 没配 / mcp 启动崩）

---

## 报告位置

`test/golden/reports/<YYYY-MM-DD>-dremio.jsonl`

每行一条记录 + 最后一行 summary：

```jsonl
{"type":"record","id":"DRM-001","layer":"L1","score":{"pass":true,...},"latencyMs":234,...}
{"type":"record","id":"DRM-002","layer":"L1",...}
...
{"type":"summary","total":20,"passed":18,"byLayer":{"L1":{"total":7,"passed":7,"rate":1},"L2":{"total":10,"passed":8,"rate":0.8},...},"meetsGate":true}
```

---

## 评分维度

每题在 scorer 里走两个维度：

1. **`expected.must_mention`** — answer 文本必须含的关键词；支持 `"A 或 B"` 多选一
2. **`expected.tool_calls.must_invoke`** — LLM 实际调了哪些工具（substring 匹配，所以写 `RunSqlQuery` 即可，不必写完整 `mcp__dremio__RunSqlQuery`）

**两条都 ≥ 80% 命中**才 pass。

---

## 常见失败 & 修法

| 现象 | 原因 | 修 |
|---|---|---|
| `[real] dremio MCP server not ready` | mcp.json 里 dremio 没起来 / token 过期 / 代理吞 localhost | 单独跑 `dremio-mcp-server run` 看错；curl `/apiv2/login` 拿新 token |
| L1 全部 fail，answer 含 `[mcp call error]` | dremio-mcp 工具的 args 字段名不对（`name` vs `table_name` vs `schema_name`） | 改对应 yaml 的 `mcp.args` |
| L2 fail，`tool=0/1` | LLM 没调 dremio 工具凭空编答案（`unsloth/qwen3.6-27b` 等弱模型常见） | 在 prompt 加 "用 dremio MCP 工具" / 换更强 reasoning 模型 |
| L2 fail，`mention` 缺关键词 | 模型答案太短或 hallucinate | 看 `answerExcerpt` 字段定位；可调低 must_mention 命中数 |
| DRM-006 fail（sys.options） | dremio 版本不暴露该表 | 改 yaml 用 `sys.tables_recent` 或砍掉这题 |

---

## 加新题

复制 `DRM-TEMPLATE.yaml` → `DRM-021.yaml`，参考已有题填字段：

- L1 题 → `mcp.{server,tool,args}` 必填，`prompt` 留空
- L2 题 → `prompt` 必填，`expected.tool_calls.must_invoke` 必填
- E 题 → 看具体场景，`mcp.expectError: true` 是常见标记

提交前跑 `npm run golden:dremio -- --dry-run --id DRM-021` 单题校验 schema。

---

## 设计取舍

- **不在 Dremio 里造表**：全用 `INFORMATION_SCHEMA` / `sys.*` 系统资源 + `VALUES` 内联表，OSS 装完即可跑，不需要 admin 配 source。
- **L1 ≠ `/mcp tools` slash**：列工具属于 codeclaw 客户端能力；runner 启动日志已打印 "X tools available"，所以 yaml 不重复测。
- **L2 跑真 LLM**：mock 模式仅骨架自测；真测必须 `--real`，因为 LLM 的 tool_use 能力是这套测试的核心被试。
- **gate 分层**：L1 100% 因为只要链路通就该全过；L2 80% 容忍模型偶发不调工具；E 66% 留容错（3 题至少 2 过）。
