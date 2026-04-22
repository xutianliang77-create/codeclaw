# CodeClaw ver 0.5 技术设计文档

> **版本**: v0.5-cc-aligned | **日期**: 2026-04-21  
> **状态**: 最终设计稿  
> **定位**: 个人自主智能体平台 · 从"接收指令"到"交付结果"的全自动闭环  
> **关联文档**: `DESIGN.md`（功能规格书）、`VER_0.5_DEV_TASKS.md`（开发任务清单）  
> **参考来源**: Claude Code v2.1.88 反编译源码（从 npm `@anthropic-ai/claude-code` v2.1.88 提取）

> **文档约束**: `DESIGN.md` 是功能与阶段的单一事实源；本文档只负责实现细化、工程约束和验收方式，不单独发明新的权限模式、阶段定义或渠道优先级。

---

## 目录

- [一、产品定位与 CodeClaw 独特优势](#一产品定位与-codeclaw-独特优势)
- [二、技术栈选型](#二技术栈选型)
- [三、整体架构（物理视图）](#三整体架构物理视图)
- [四、各层详细设计](#四各层详细设计)
- [五、数据流设计](#五数据流设计)
- [六、核心组件设计](#六核心组件设计)
- [七、部署与运维](#七部署与运维)
- [八、里程碑与迭代计划](#八里程碑与迭代计划)
- [九、风险评估与应对](#九风险评估与应对)
- [附录 A: 与 Claude Code 深度对照](#附录-a-与-claude-code-深度对照)
- [附录 B: Auto-Compact 对比论证](#附录-b-auto-compact-对比论证)
- [附录 C: Command 系统对照清单](#附录-c-command-系统对照清单)
- [附录 D: 数据模型详细定义](#附录-d-数据模型详细定义)
- [附录 E: API 契约参考](#附录-e-api-契约参考)

---

## 一、产品定位与 CodeClaw 独特优势

### 1.1 产品定位

CodeClaw **不是编程助手**，而是**个人自主智能体平台**：
- **深度语义理解** — 通过 LSP 图谱理解代码结构和依赖关系
- **长程任务规划** — 自主拆解目标、规划、执行、纠偏、闭环交付
- **多渠道交互** — CLI/微信/SDK 统一接入

### 1.2 CodeClaw 相比 Claude Code 的独特优势

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  CodeClaw vs Claude Code — 定位与架构差异                                        │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────┬──────────────────────┬──────────────────────────┐   │
│  │ 维度                   │ Claude Code           │ CodeClaw                 │   │
│  ├─────────────────────────┼──────────────────────┼──────────────────────────┤   │
│  │ 定位                   │ 单人编程 Agent        │ 个人自主智能体平台         │   │
│  │ 交互渠道               │ CLI + Web UI         │ CLI + 微信 + SDK + MCP  │   │
│  │ 任务编排               │ 单轮循环 + 插件       │ Planner → Executor →    │   │
│  │                         │                      │ Reflector 长程闭环        │   │
│  │ 记忆系统               │ Rolling Buffer +     │ L1 Buffer + L2 Session +  │   │
│  │                        │ 压缩摘要              │ L3 CodebaseRAG + Embed  │   │
│  │ 工具生态               │ 内建工具 + MCP        │ Tool + Skill + Hook +    │   │
│  │                        │                      │ Plugin + Intent + LSP     │   │
│  │ 审批流                 │ auto/plan/deny 三种   │ ApprovalManager: 创建/    │   │
│  │                        │                      │ 响应/超时/恢复全生命周期  │   │
│  │ 记忆持久化             │ JSONL                │ JSONL + SQLite (Phase 1.9)│  │
│  │ 意图识别               │ ❌                   │ Intent Parser + Classifier│   │
│  │ 多 Agent 协作          │ Fork SubAgent        │ Leader/Worker 多角色协同  │   │
│  │ 微信集成               │ ❌                   │ iLink 微信 Bot 集成       │   │
│  │ 多模型支持             │ Anthropic 优先       │ Anthropic/OpenAI/Ollama  │   │
│  │                        │                      │ + LMStudio 本地部署       │   │
│  │ 成本可控               │ 按量付费             │ CostTracker + 预算告警 +  │   │
│  │                        │                      │ 多模型成本对比             │   │
│  │ 离线可用               │ ❌                   │ Ollama/LMStudio 完全离线  │   │
│  │ 开放扩展               │ 插件系统              │ Skill + Hook + Plugin +  │   │
│  │                        │                      │ Intent 四层扩展            │   │
│  └─────────────────────────┴──────────────────────┴──────────────────────────┘   │
│                                                                                  │
│  CodeClaw 核心差异化:                                                              │
│  1. 多渠道统一接入 (CLI + 微信 + SDK + MCP)                                     │
│  2. Planner → Executor → Reflector 长程闭环                                      │
│  3. 三层记忆系统 (Rolling Buffer + SessionMem + CodebaseRAG)                     │
│  4. 完整意图识别 (Intent Parser + Classifier)                                   │
│  5. 多层扩展生态 (Tool + Skill + Hook + Plugin + Intent)                        │
│  6. 多模型兼容 (Anthropic/OpenAI/Ollama/LMStudio)                               │
│  7. 成本可控 (CostTracker + 预算告警 + 多模型切换)                              │
│  8. 完全离线 (Ollama/LMStudio 本地部署)                                         │
│  9. 微信集成 (iLink 微信 Bot)                                                   │
│  10. 多 Agent 协同 (Leader/Worker 多角色协同)                                   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 核心设计原则

```
1. 个人版优先 — 不做企业级功能（遥测/MDM/工作树隔离）
2. 渐进增强 — MVP 先跑通核心闭环，后续迭代增强
3. 开源可维护 — 代码结构清晰，不依赖 Claude Code 专有模块
4. 多模型兼容 — Provider 抽象层隔离 LLM 依赖
5. 零依赖起步 — 核心功能不依赖外部库，生产级按需引入
6. 对齐成熟方案 — Auto-Compact/Command 系统参考 Claude Code 经过验证的设计
7. CodeClaw 差异化 — 多渠道/长程闭环/三层记忆/意图识别/多 Agent 协同
```

---

## 二、技术栈选型

### 2.1 语言与运行时

| 层级 | 技术选型 | 理由 |
|------|---------|------|
| **主语言** | TypeScript 5.x | 全栈统一类型系统，与 Claude Code 源码生态兼容 |
| **运行时** | Node.js 22 LTS | Long-term support，V8 性能成熟，ESM/CJS 双兼容 |
| **构建** | esbuild + bun (feature-gated build) | 快速编译，支持 `feature()` 编译时死代码消除 |
| **包管理** | npm 10+ | 兼容 monorepo (workspaces) |
| **构建辅助** | Bun 1.x | 仅用于正式 bundle 与 feature 开关打包 |

### 2.2 核心依赖

| 类别 | 库名 | 版本 | 用途 | 阶段 |
|------|------|------|------|------|
| CLI 渲染 | `ink` | latest | React-based TUI (Spinner/Progress) | MVP ✅ |
| 测试 | `vitest` | latest | 单元测试 | MVP ✅ |
| 配置 | `js-yaml` | latest | YAML 解析（生产级稳定） | MVP ✅ |
| LLM 集成 | native `fetch` | — | Anthropic/OpenAI/Ollama/LMStudio 调用 | MVP ✅ |
| 微信 Bot | `wechaty` | latest | iLink 微信接入 | Phase 3 |
| LSP | `multilspy` | latest | 跨语言服务器协议 | Phase 1.5 |
| 向量检索 | `bge-m3` (ONNX) | latest | 语义 embedding (L3 RAG) | Phase 3 |
| 数据库 | `better-sqlite3` | latest | 持久化（Phase 1.9） | Phase 1.9 |
| 日志 | `pino` | latest | 结构化日志 | Phase 4 |
| i18n | `i18next` | latest | 双语国际化 | Phase 3 |

### 2.3 构建系统（Bun + esbuild）

原理：参考 Claude Code `scripts/build.mjs` + `stubs/bun-bundle.ts`。

```
src/ (含 feature('FEATURE') 门控)
  ↓ feature() 编译时求值
  ├─ true → 保留
  └─ false → 死代码消除
  ↓ esbuild 打包
dist/cli.js (ESM CLI bundle)
```

**stubs/bun-bundle.ts** — feature() 桩文件（控制功能开关）：

```typescript
// 外部构建时返回固定值，控制各功能模块是否打包
export function feature(name: string): boolean {
  const FEATURES: Record<string, boolean> = {
    COORDINATOR_MODE: false,    // 多代理协调
    KAIROS: false,              // Kairos 助手模式
    PROACTIVE: false,           // 主动通知
    CONTEXT_COLLAPSE: false,    // 上下文折叠 (L4 压缩)
    REACTIVE_COMPACT: false,    // 响应式压缩 (L2)
    CACHED_MICROCOMPACT: false, // 微压缩 (L5)
    HISTORY_SNIP: false,        // 历史 snip
    TOKEN_BUDGET: true,         // Token 预算
    VOICE_MODE: false,          // 语音模式
    FORK_SUBAGENT: false,       // 子代理 Fork
    CHICAGO_MCP: false,         // Chicago MCP
    BG_SESSIONS: false,         // 后台会话
    EXPERIMENTAL_SKILL_SEARCH: false, // 技能搜索
    MONITOR_TOOL: false,        // 监控工具
  };
  return FEATURES[name] ?? false;
}
```

### 2.4 开发环境与编译规范

**链路拆分**：

| 链路 | 工具 | 目的 |
|------|------|------|
| 本地开发 | Node.js 22 + npm | 开发、调试、测试、类型检查 |
| 正式打包 | Bun 1.x + esbuild | 产出 feature-gated bundle |

**标准脚本约定**：

```json
{
  "scripts": {
    "dev": "tsx src/cli.tsx",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "build": "bun run scripts/build.mjs",
    "start": "node dist/cli.js"
  }
}
```

**规范**：

1. 本地开发默认使用 `npm run dev`
2. 正式发布前必须执行 `npm run typecheck`、`npm run test`、`bun run build`
3. `build` 的唯一职责是生成发布 bundle，不承担测试逻辑
4. `start` 只运行已打包产物，不指向源码入口
5. CI 默认执行 `typecheck + test + build`

---

## 三、整体架构（物理视图）

### 3.1 CodeClaw Runtime 物理视图

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                            CodeClaw Runtime                                           │
│                                                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │   CLI REPL   │  │  SDK/HTTP    │  │  微信 Bot     │  │  MCP External Client     │  │
│  │  (Ink TUI)   │  │  Gateway     │  │  (wechaty)   │  │  (stdio/sse 工具提供者)  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────────┬──────────────┘  │
│         │                 │                  │                       │                  │
│         └─────────────────┴──────────────────┴───────────────────────┘                  │
│                              │                                                           │
│                    ┌─────────▼──────────┐                                               │
│                    │  Ingress Gateway    │ ← 【CodeClaw 优势 1: 多渠道统一接入】         │
│                    │  (统一接入层)       │   Claude Code: CLI/Web UI 两个独立入口      │
│                    │                    │   CodeClaw: CLI + 微信 + SDK + MCP 统一通道  │
│                    │  SessionManager    │                                               │
│                    │  PriorityRouter    │                                               │
│                    │  PermitGate        │                                               │
│                    └─────────┬──────────┘                                               │
│                              │                                                           │
│              ┌───────────────▼───────────────┐                                           │
│              │      CodeClaw Core Engine      │ ← 【CodeClaw 优势 2: 长程任务编排】     │
│              │      (七层架构运行在单体进程内)   │   Claude Code: 单轮循环 + 插件        │
│              │                                │   CodeClaw: Planner→Executor→         │
│              │  ┌─────────────────────────┐   │   Reflector 长程闭环 + Intent 识别    │
│              │  │   SessionManager        │   │   ┌──────────────────────────────┐   │
│              │  │  (会话管理/上下文装载/  │   │   │   Planner → Executor →      │   │
│              │  │   结果投递)             │   │   │   Reflector + ApprovalMgr    │   │
│              │  │                         │   │   │   IntentParser               │   │
│              │  │   ┌─────────────────┐   │   │   │   Reflector(Gap Analysis)  │   │
│              │  │   │ Planner        │   │   │   │   FSMLoop + CostTracker    │   │
│              │  │   │ (目标拆解/DAG) │   │   │   └──────────────────────────────┘   │
│              │  │   └─────────────────┘   │   │                                            │
│              │  │   ┌─────────────────┐   │   │                                            │
│              │  │   │ Executor       │   │   │                                            │
│              │  │   │ (DAG 调度)     │   │   │                                            │
│              │  │   └─────────────────┘   │   │                                            │
│              │  │   ┌─────────────────┐   │   │                                            │
│              │  │   │ Reflector      │   │   │                                            │
│              │  │   │ (Gap Analysis) │   │   │                                            │
│              │  │   └─────────────────┘   │   │                                            │
│              │  │   ┌─────────────────┐   │   │                                            │
│              │  │   │ ApprovalMgr    │   │   │                                            │
│              │  │   │ (审批流管理)     │   │   │                                            │
│              │  │   │ 创建/响应/超时   │   │   │                                            │
│              │  │   │ /恢复            │   │   │                                            │
│              │  │   └─────────────────┘   │   │                                            │
│              │  └─────────────────────────┘   │                                            │
│              │                                │                                            │
│              │  ┌─────────────────────────┐   │                                            │
│              │  │   Cognitive Layer       │   │  ← 【CodeClaw 优势 3: 三层记忆系统】       │
│              │  │   (认知层)              │   │   Claude Code: Rolling Buffer + 压缩     │
│              │  │                         │   │   CodeClaw: L1 Buffer + L2 Session +    │
│              │  │  ┌─────────────────┐    │   │   L3 CodebaseRAG + bge-m3 Embedding    │
│              │  │  │ L1: Rolling     │    │   │                                            │
│              │  │  │    Buffer       │    │   │                                            │
│              │  │  └─────────────────┘    │   │                                            │
│              │  │  ┌─────────────────┐    │   │                                            │
│              │  │  │ Auto-Compact    │    │   │                                            │
│              │  │  │ 五层压缩系统    │    │   │                                            │
│              │  │  └─────────────────┘    │   │                                            │
│              │  │  ┌─────────────────┐    │   │                                            │
│              │  │  │ L2: SessionMem  │    │   │                                            │
│              │  │  │ (JSONL→SQLite)  │    │   │                                            │
│              │  │  └─────────────────┘    │   │                                            │
│              │  │  ┌─────────────────┐    │   │                                            │
│              │  │  │ L3: CodebaseRAG │    │   │                                            │
│              │  │  │ (BM25+向量检索) │    │   │                                            │
│              │  │  │ Embedding(bge-m3)│   │   │                                            │
│              │  │  └─────────────────┘    │   │                                            │
│              │  └─────────────────────────┘   │                                            │
│              │                                │                                            │
│              │  ┌─────────────────────────┐   │                                            │
│              │  │   Capability Layer      │   │  ← 【CodeClaw 优势 4: 多层扩展生态】       │
│              │  │   (能力层)              │   │   Claude Code: Tool + Plugin + MCP       │
│              │  │                         │   │   CodeClaw: Tool + Skill + Hook +       │
│              │  │  ┌─────────────────┐    │   │   Plugin + Intent + LSP 四层扩展         │
│              │  │  │ Tool Registry   │    │   │                                            │
│              │  │  │ (Read/Write/Bash│    │   │                                            │
│              │  │  │ /Glob/Grep/LSP/ │    │   │                                            │
│              │  │  │ MCP/Agent/Task/ │    │   │                                            │
│              │  │  │ Skill/Intent)   │    │   │                                            │
│              │  │  └─────────────────┘    │   │                                            │
│              │  └─────────────────────────┘   │                                            │
│              │                                │                                            │
│              │  ┌─────────────────────────┐   │                                            │
│              │  │   Infrastructure Layer  │   │                                            │
│              │  │   (基础设施层)          │   │                                            │
│              │  │                         │   │                                            │
│              │  │  CostTracker ·          │   │                                            │
│              │  │  PermissionGate ·       │   │                                            │
│              │  │  AuditLog · SQLite ·    │   │                                            │
│              │  │  JSONL · Pino · i18n   │   │                                            │
│              │  └─────────────────────────┘   │                                            │
│              └────────────────────────────────┘                                            │
│                              │                                                           │
│              ┌───────────────▼───────────────┐                                           │
│              │   Provider Layer               │  ← 【CodeClaw 优势 5: 多模型兼容】       │
│              │   (模型提供商)                 │   Claude Code: Anthropic 优先           │
│              │                               │   CodeClaw: Anthropic + OpenAI +       │
│              │  ┌──────┐ ┌──────┐ ┌──────┐  │   Ollama + LMStudio 四模型            │
│              │  │Anthropic│ │ OpenAI│ │ Ollama│  │                                            │
│              │  │  API  │ │  API  │ │ Local │  │                                            │
│              │  └──────┘ └──────┘ └──────┘  │                                            │
│              │  ┌──────┐                    │                                            │
│              │  │LMStudio│                    │                                            │
│              │  │ Local  │                    │                                            │
│              │  └──────┘                    │                                            │
│              └────────────────────────────────┘                                            │
│                                                                                        │
│  CodeClaw 核心差异化总结:                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │ 1. 多渠道统一接入: CLI + 微信 + SDK + MCP                                      │    │
│  │ 2. 长程任务编排: Planner → Executor → Reflector + ApprovalManager              │    │
│  │ 3. 三层记忆系统: L1 Buffer + L2 Session + L3 CodebaseRAG + Embedding           │    │
│  │ 4. 多层扩展生态: Tool + Skill + Hook + Plugin + Intent + LSP                   │    │
│  │ 5. 多模型兼容: Anthropic + OpenAI + Ollama + LMStudio                         │    │
│  │ 6. 意图识别: IntentParser + Classifier                                        │    │
│  │ 7. 多 Agent 协同: Leader/Worker 多角色协同                                     │    │
│  │ 8. 成本可控: CostTracker + 预算告警 + 多模型成本对比                            │    │
│  │ 9. 完全离线: Ollama/LMStudio 本地部署                                          │    │
│  │ 10. 微信集成: iLink 微信 Bot                                                    │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 CodeClaw 五大核心优势详解

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  CodeClaw vs Claude Code — 核心优势对比                                         │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │ 优势 1: 多渠道统一接入                                                        │  │
│  │ ─────────────────────────────────────────────────────────────────────────────  │
│  │                                                                              │  │
│  │ Claude Code:                                                                │  │
│  │   • CLI REPL (Ink TUI) — 独立入口                                           │
│  │   • Web UI — 独立入口                                                       │
│  │   • 两套独立代码路径，状态隔离                                                │
│  │                                                                              │  │
│  │ CodeClaw:                                                                   │  │
│  │   • CLI REPL (Ink TUI) ─┐                                                   │  │
│  │   • iLink 微信 Bot ─────┤ ──▶ ChannelAdapter ──▶ IngressGateway ──▶ 统一Session │
│  │   • SDK/HTTP Gateway ──┘                                                   │  │
│  │   • MCP External Client ───────────────────────────────────────────────┘     │  │
│  │                                                                              │  │
│  │   所有渠道共享同一 SessionManager，支持跨渠道会话恢复                           │  │
│  │   渠道间消息可无缝转发 (e.g., 微信消息 → CLI 输出)                            │  │
│  │                                                                              │  │
│  │ 差异化价值: 用户可在任何渠道接入同一 Agent，无需重复配置                        │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │ 优势 2: 长程任务编排                                                        │  │
│  │ ─────────────────────────────────────────────────────────────────────────────  │
│  │                                                                              │  │
│  │ Claude Code:                                                                │  │
│  │   • 单轮循环: buildCtx → callModel → toolExec → continue/return             │
│  │   • 复杂任务: 通过插件/工具链实现                                             │
│  │   • 无显式 Planner/Reflector                                                │
│  │                                                                              │  │
│  │ CodeClaw:                                                                   │  │
│  │   ┌──────────────────────────────────────────────────────────────────────┐   │  │
│  │   │  Planner (目标拆解) → Executor (DAG 调度) → Reflector (Gap Analysis)│   │  │
│  │   │                                                                        │   │  │
│  │   │  Planner:                                                              │   │  │
│  │   │  · 解析用户目标 → 子目标列表                                           │
│  │   │  · 构建依赖 DAG                                                         │
│  │   │  · 预估成本 + 风险评估                                                  │
│  │   │  · 输出: { goals: [{id, description, deps, budget}], dag: {...} }    │
│  │   │                                                                        │   │  │
│  │   │  Executor:                                                             │   │  │
│  │   │  · 拓扑排序 DAG → 执行顺序                                              │
│  │   │  · 并行执行无依赖子任务                                                  │
│  │   │  · 失败自动重试 (max 3 次)                                              │
│  │   │  · 成本追踪 (每子任务)                                                  │
│  │   │  · 输出: { completed: Task[], failed: Task[], cost: CostReport }     │
│  │   │                                                                        │   │  │
│  │   │  Reflector (Gap Analysis):                                             │   │  │
│  │   │  · 对比预期结果 vs 实际结果                                             │
│  │   │  · 检测未覆盖的 Gap                                                    │
│  │   │  · 生成新的子目标 → 回传 Planner 重新规划                               │
│  │   │  · 输出: { gaps: [{id, severity, description}], newGoals?: Goal[] }  │
│  │   │                                                                        │   │  │
│  │   │  闭环逻辑:                                                              │   │  │
│  │   │  while (gaps.length > 0) {                                            │
│  │   │    planner.plan(gaps) → dag                                          │
│  │   │    executor.execute(dag) → result + gaps                              │
│  │   │    if (!result.completedAll()) gaps = gaps.concat(result.gaps)       │
│  │   │  }                                                                     │
│  │   │                                                                        │   │  │
│  │   │  ApprovalManager: 审批流全生命周期管理                                   │
│  │   │  · 创建审批: 复杂操作前提交审批                                          │
│  │   │  · 响应审批: 接收用户审批结果                                            │
│  │   │  · 超时处理: 审批超自动降级/重试                                        │
│  │   │  · 恢复: 断连后恢复审批状态                                             │
│  │   └──────────────────────────────────────────────────────────────────────┘   │  │
│  │                                                                              │  │
│  │ 差异化价值: 可自主完成跨文件、跨模块的复杂任务，而非单轮工具调用              │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │ 优势 3: 三层记忆系统                                                        │  │
│  │ ─────────────────────────────────────────────────────────────────────────────  │
│  │                                                                              │  │
│  │ Claude Code:                                                                │  │
│  │   L1: Rolling Buffer (最近 N 条消息)                                        │
│  │   Auto-Compact: 压缩摘要                                                     │
│  │   (无 L3 代码库索引)                                                        │
│  │                                                                              │  │
│  │ CodeClaw:                                                                   │  │
│  │   L1: Rolling Buffer (最近 N 条消息)                                        │  │
│  │     · 保持最近 N 条消息在内存 (默认 100 条或 80% 上下文)                    │  │
│  │     · 超出部分由 Auto-Compact L1 处理                                        │  │
│  │     · 优化: readFileState (文件状态缓存 — 避免重复读取文件)                   │  │
│  │                                                                              │  │
│  │   L2: Session Memory (压缩摘要持久化)                                       │  │
│  │     · CompactBoundaryMessage 中的压缩摘要持久化                              │  │
│  │     · JSONL → SQLite (Phase 1.9)                                           │  │
│  │     · 支持跨会话加载                                                         │  │
│  │     · 压缩指标: 10+ 项 (originalMessageCount, preCompactTokenCount 等)      │  │
│  │                                                                              │  │
│  │   L3: Codebase RAG (代码库索引 + 向量检索)                                  │  │
│  │     · 代码库文件 → BM25 索引 (快速关键词匹配)                               │  │
│  │     · bge-m3 embedding → 向量存储 (语义检索)                                │  │
│  │     · 混合检索: BM25 score + cosine similarity                              │  │
│  │     · 增量更新: 文件修改触发索引更新                                         │  │
│  │     · 索引范围: src/、lib/、config/ (排除 node_modules/.git)               │  │
│  │                                                                              │  │
│  │   记忆加载时机:                                                              │  │
│  │   · Agent Loop 每轮: startRelevantMemoryPrefetch()                          │  │
│  │   · 异步预加载: memoryAttachments + skillDiscoveryAttachments               │  │
│  │   · 中间注入: getAttachmentMessages() → 注入为 tool_results                  │  │
│  │                                                                              │  │
│  │ 差异化价值: L3 CodebaseRAG 使 Agent 理解整个代码库结构，而非仅当前会话上下文  │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │ 优势 4: 多层扩展生态                                                        │  │
│  │ ─────────────────────────────────────────────────────────────────────────────  │
│  │                                                                              │  │
│  │ Claude Code:                                                                │  │
│  │   · Tool (内建工具 + MCP)                                                   │
│  │   · Plugin (插件系统)                                                       │
│  │   · Hook (钩子系统)                                                         │
│  │                                                                              │  │
│  │ CodeClaw:                                                                   │  │
│  │   Layer 1: Tool Registry (工具注册表)                                        │  │
│  │     · Read/Write/Edit/Glob/Grep/Bash (内建工具)                             │  │
│  │     · LSP (代码库符号查询)                                                  │  │
│  │     · MCP (外部工具)                                                        │  │
│  │     · Agent (子代理工具)                                                    │  │
│  │     · Task (任务管理工具)                                                   │  │
│  │     · Skill (技能触发)                                                      │  │
│  │                                                                              │  │
│  │   Layer 2: Skill System (技能系统)                                          │  │
│  │     · 加载 .codeclaw/skills/ 目录下的 SKILL.md 文件                         │  │
│  │     · 类型: prompt/skill/tool/skill-based-tool                              │  │
│  │     · 动态发现: getSlashCommandToolSkills(dir) + getDynamicSkills()         │  │
│  │     · 技能预加载: startSkillDiscoveryPrefetch() 异步触发                     │  │
│  │                                                                              │  │
│  │   Layer 3: Hook System (钩子系统)                                           │  │
│  │     · 7 种生命周期钩子: pre/post_tool_use, pre/post_compact,                │  │
│  │       session_start, pre/post_stream                                        │  │
│  │     · 注册: .codeclaw/hooks/ 目录下的 hook 脚本                             │  │
│  │     · 执行: executePostSamplingHooks() / executeStopHooks()                 │  │
│  │     · 钩子输出: hook_result 可触发后续行为                                   │  │
│  │                                                                              │  │
│  │   Layer 4: Plugin System (插件系统)                                         │  │
│  │     · 3 类插件: 内建/用户/Marketplace                                       │  │
│  │     · 加载: .codeclaw/plugins/ + Marketplace                                │  │
│  │     · 命令集成: getPluginCommands(dirs) → 注册插件命令                       │  │
│  │                                                                              │  │
│  │   Layer 5: Intent System (意图系统)                                         │  │
│  │     · IntentParser: 解析用户输入为结构化意图                                 │
│  │     · IntentClassifier: 分类意图 (task/query/create/fix/analyze)            │
│  │     · IntentRouter: 路由到对应 Executor                                     │
│  │                                                                              │  │
│  │ 差异化价值: 5 层扩展生态，从工具到意图的全方位可扩展                          │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │ 优势 5: 多模型兼容                                                            │  │
│  │ ─────────────────────────────────────────────────────────────────────────────  │
│  │                                                                              │  │
│  │ Claude Code:                                                                │  │
│  │   · Anthropic Claude 优先 (部分功能仅限 Anthropic)                           │
│  │   · 有限 OpenAI 兼容                                                       │
│  │                                                                              │  │
│  │ CodeClaw:                                                                   │  │
│  │   Provider 抽象层 (统一接口):                                               │  │
│  │   ┌──────────────────────────────────────────────────────────────────────┐   │  │
│  │   │  abstract class Provider {                                           │   │  │
│  │   │    name: string;                                                     │   │  │
│  │   │    config: ProviderConfig;                                           │   │  │
│  │   │                                                                      │   │  │
│  │   │    abstract sendMessage(                                            │   │  │
│  │   │      messages: Message[],                                            │   │  │
│  │   │      tools?: Tool[],                                                 │   │  │
│  │   │      options?: ProviderOptions                                       │   │  │
│  │   │    ): AsyncGenerator<ProviderStreamEvent>                            │   │  │
│  │   │                                                                      │   │  │
│  │   │    abstract getModels(): Promise<ModelInfo[]>                       │   │  │
│  │   │    abstract getLimits(): ProviderLimits                              │   │  │
│  │   │  }                                                                   │   │  │
│  │   └──────────────────────────────────────────────────────────────────────┘   │  │
│  │                                                                              │  │
│  │   实现类:                                                                    │  │
│  │   · AnthropicProvider (Claude API, native fetch)                            │  │
│  │   · OpenAIProvider (OpenAI 兼容 API, native fetch)                          │  │
│  │   · OllamaProvider (本地 Ollama, native fetch)                              │  │
│  │   · LMStudioProvider (本地 LMStudio, native fetch)                          │  │
│  │                                                                              │  │
│  │   ModelRouter (模型路由):                                                   │  │
│  │   · 用户指定 model → 直接用                                                  │
│  │   · permissionMode = 'plan' → plan 模型                                    │
│  │   · agentId? → 子代理用更便宜的模型                                         │
│  │   · 检查 provider 可用 model 列表                                           │
│  │   · fallbackModel? → 使用 fallback                                         │
│  │   · 默认 → mainLoopModel                                                   │
│  │                                                                              │  │
│  │   FallbackManager (回退管理):                                               │  │
│  │   · 检测高负载/限流 → switchModel(fallbackModel)                            │  │
│  │   · stripSignatureBlocks() → 移除 thinking 签名避免 400 错误               │  │
│  │   · retry 当前请求                                                          │  │
│  │   · yield createSystemMessage('Switched to X due to high demand')          │  │
│  │   · 回退链: model1 → model2 → model3 → ... → final fallback               │  │
│  │                                                                              │  │
│  │ 差异化价值: 支持本地部署 (Ollama/LMStudio)，完全离线可用 + 成本可控          │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                  │
│  CodeClaw 额外优势:                                                              │
│  · 成本可控: CostTracker + 预算告警 + 多模型成本对比                             │
│  · 完全离线: Ollama/LMStudio 本地部署                                           │
│  · 微信集成: iLink 微信 Bot                                                     │
│  · 多 Agent 协同: Leader/Worker 多角色协同                                     │
│  · 意图识别: IntentParser + Classifier                                        │
│  · LSP 深度集成: 代码库结构理解 + 符号查询                                      │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 七层架构（逻辑视图）

六层架构的每一层职责、内部组件、接口定义如下：

#### Layer 1: Channel Layer（接入层）

**职责**：多渠道消息适配，统一为 IngressMessage

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  Layer 1: Channel Layer                                                             │
│  ───────────────────────────────────────────────────────────────────────────────────  │
│  职责：多渠道消息适配，统一为 IngressMessage                                          │
│  位置：src/channels/                                                                │
│                                                                                      │
│  CodeClaw 优势: 5 渠道统一，Claude Code 仅 2 渠道                                    │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ ChannelAdapter (渠道适配器)                                                   │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │ 输入:  原始渠道数据 (CLI stdin, WS frame, HTTP request, wechaty event)    │  │   │
│  │ │ 输出:  IngressMessage                                                     │  │   │
│  │ │                                                                        │  │   │
│  │ │ 适配逻辑:                                                               │  │   │
│  │ │  1. channel: 'cli' | 'sdk' | 'wechat' | 'mcp' | 'http'              │  │   │
│  │ │  2. 解析输入格式 → 标准化 IngressMessage                              │  │   │
│  │ │  3. 附加 channel 元数据 (transport, source, priority)                  │  │   │
│  │ │  4. 异常处理 → IngressError                                           │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  渠道实现:                                                                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ CLI      │  │ SDK      │  │ 微信     │  │ MCP      │  │ HTTP     │             │
│  │ Channel  │  │ Channel  │  │ Channel  │  │ Channel  │  │ Channel  │             │
│  │          │  │          │  │          │  │          │  │          │             │
│  │ stdin    │  │ async    │  │ wechaty  │  │ stdio    │  │ express  │             │
│  │ Ink TUI  │  │ generator│  │ event    │  │ MCPB     │  │ handler  │             │
│  │ 流式输出 │  │          │  │ 回调     │  │ Server   │  │          │             │
│  │          │  │          │  │          │  │          │  │          │             │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘             │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ IngressMessage (统一消息格式)                                                  │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │  channel: 'cli' | 'sdk' | 'wechat' | 'mcp' | 'http'                      │  │   │
│  │  userId: string                                                              │  │   │
│  │  sessionId: string | null  (由 IngressGateway 映射)                         │  │   │
│  │  input: string | ContentBlockParam[]  (用户输入内容)                         │  │   │
│  │  priority: 'high' | 'normal'                                               │  │   │
│  │  timestamp: number                                                           │  │   │
│  │  metadata: {                                                                │  │   │
│  │    transport?: 'stdio' | 'ws' | 'sse' | 'rest' | 'stdin'                 │  │   │
│  │    source?: 'user' | 'hook' | 'command' | 'system'                       │  │   │
│  │    parentToolUseId?: string                                                │  │   │
│  │    isInterrupt?: boolean                                                    │  │   │
│  │    channelSpecific?: Record<string, unknown>  // 渠道特定字段               │  │   │
│  │  }                                                                          │  │   │
│  └───────────────────────────────────────────────────────────────────────────┘   │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Layer 2: Ingress Layer（入口层）

**职责**：Session 映射、优先级路由、消息缓冲、权限预检

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  Layer 2: Ingress Layer                                                             │
│  ───────────────────────────────────────────────────────────────────────────────────  │
│  职责：Session 映射、优先级路由、消息缓冲、权限预检                                    │
│  位置：src/ingress/                                                                 │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ IngressGateway (统一入口)                                                      │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  核心职责:                                                                │  │   │
│  │ │  1. SessionManager — 多渠道 session 映射                                 │  │   │
│  │ │  2. PriorityRouter — 消息优先级调度                                       │  │   │
│  │ │  3. MessageBuffer — WebSocket 断连消息缓冲                               │  │   │
│  │ │  4. PermitGate — 权限预检（auto-mode/plan-mode）                         │  │   │
│  │ │                                                                          │  │   │
│  │ │  入口方法:                                                                │  │   │
│  │ │  async handleMessage(msg: IngressMessage): AsyncGenerator<SDKMessage>   │  │   │
│  │ │  async handleInterrupt(sessionId: string): void                          │  │   │
│  │ │  async getActiveSessions(): SessionInfo[]                                │  │   │
│  │ │  async destroySession(sessionId: string): Promise<void>                  │  │   │
│  │ │                                                                          │  │   │
│  │ │  CodeClaw 优势: 跨渠道共享 Session                                       │  │   │
│  │ │  Claude Code: CLI/Web UI 各自独立 Session                               │  │   │
│  │ │  CodeClaw: 微信消息 ↔ CLI 消息可无缝转发                                 │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐        │
│  │ SessionManager      │  │ PriorityRouter      │  │ MessageBuffer       │        │
│  │                     │  │                     │  │                     │        │
│  │ sessionKeyMap:      │  │ highPriorityQueue:  │  │ wsDisconnected:    │        │
│  │   Map<             │  │   Array<            │  │   Map<             │        │
│  │     string,         │  │       IngressMsg   │  │     sessionId      │        │
│  │     SessionState   │  │   >                │  │     → IngressMsg[] │        │
│  │   >                │  │                     │  │   >                │        │
│  │                     │  │ flushPriority():    │  │                     │        │
│  │ 映射规则:           │  │   flush high first │  │ 缓冲区大小: 100    │        │
│  │ (channel:userId)   │  │ → flush normal     │  │ 超时: 5min         │        │
│  │ → sessionId        │  │ → flush low        │  │ 背压策略: drop oldest│      │
│  │                     │  │                     │  │                     │        │
│  │ SessionState:       │  │ 优先级:  >normal    │  │ 断连检测:          │        │
│  │ {                  │  │   >task-notif      │  │  · WS heartbeat    │        │
│  │   sessionState,   │  │   >prompt          │  │  · stdin close     │        │
│  │   lastActivity,    │  │   >local           │  │  · SIGTERM         │        │
│  │   channel,         │  │                     │  │                     │        │
│  │   ...              │  │                     │  │                     │        │
│  │ }                  │  │                     │  │                     │        │
│  └─────────────────────┘  └─────────────────────┘  └─────────────────────┘        │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ PermitGate (权限预检)                                                          │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  根据 permissionMode 决定消息是否可以直接进入 Agent Loop:                 │  │   │
│  │ │                                                                          │  │   │
│  │ │  mode = 'auto':                                                          │  │   │
│  │ │    → 免审批，直接放行                                                     │  │   │
│  │ │                                                                          │  │   │
│  │ │  mode = 'plan':                                                          │  │   │
│  │ │    → 需用户审批，显示审批卡片                                              │  │   │
│  │ │    → 用户点击 "Approve" → 放行                                           │  │   │
│  │ │    → 用户点击 "Deny" → 拒绝，返回错误                                    │  │   │
│  │ │                                                                          │  │   │
│  │ │  mode = 'default':                                                       │  │   │
│  │ │    → 首次需审批（首次对话），之后 auto                                    │  │   │
│  │ │                                                                          │  │   │
│  │ │  权限预检结果:                                                            │  │   │
│  │ │  {                                                                      │  │   │
│  │ │    allowed: boolean,                                                    │  │   │
│  │ │    reason: 'auto-approved' | 'needs-approval' | 'denied' | 'default-approve' │  │   │
│  │ │    requiresUI?: boolean  // 是否需要 UI 交互                            │  │   │
│  │ │  }                                                                      │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Layer 3: Orchestration Layer（编排层）

**职责**：Planner → Executor → Reflector 长程闭环 + ApprovalManager 审批流

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  Layer 3: Orchestration Layer                                                       │
│  ───────────────────────────────────────────────────────────────────────────────────  │
│  职责：Planner → Executor → Reflector 长程闭环 + ApprovalManager 审批流               │
│  位置：src/orchestration/                                                           │
│                                                                                      │
│  CodeClaw 优势: 长程任务编排，Claude Code 仅单轮循环                                 │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ Planner (目标拆解引擎) — 【CodeClaw 核心差异化】                              │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  输入: userGoal (string)                                                 │  │   │
│  │ │  输出: { goals: Goal[], dag: DependencyGraph, costEstimate: Budget }     │  │   │
│  │ │                                                                          │  │   │
│  │ │  核心逻辑:                                                               │  │   │
│  │ │  1. IntentParser.parse(userGoal) → Intent { type, entities, constraints }│  │   │
│  │ │     · type: task | query | create | fix | analyze                        │  │   │
│  │ │     · entities: 识别代码文件/函数/模块                                    │  │   │
│  │ │     · constraints: 时间/成本/质量约束                                     │  │   │
│  │ │                                                                          │  │   │
│  │ │  2. IntentClassifier.classify(intent) → Strategy                         │  │   │
│  │ │     · task → DAG Planning Strategy                                      │  │   │
│  │ │     · query → Direct Response Strategy                                   │  │   │
│  │ │     · create → Scaffolding Strategy                                      │  │   │
│  │ │     · fix → Diagnostic Strategy                                          │  │   │
│  │ │     · analyze → Analysis Strategy                                        │  │   │
│  │ │                                                                          │  │   │
│  │ │  3. DAG Generator (for task strategy):                                  │  │   │
│  │ │     · 拆解子目标 (分解 → 依赖分析 → 排序)                                │  │   │
│  │ │     · 预估成本 (每个子目标的 token/时间/金钱)                             │  │   │
│  │ │     · 风险评估 (权限/破坏性/回退难度)                                    │  │   │
│  │ │     · 输出: { goals: [{id, description, deps, budget}], dag: {...} }    │  │   │
│  │ │                                                                          │  │   │
│  │ │  示例:                                                                   │  │   │
│  │ │  输入: "添加用户认证功能"                                                │  │   │
│  │ │  输出:                                                                  │  │   │
│  │ │  goals: [                                                               │  │   │
│  │ │    {id: "G1", deps: [], budget: {tokens: 5k, cost: $0.01}},            │  │   │
│  │ │    {id: "G2", deps: ["G1"], budget: {tokens: 8k, cost: $0.02}},       │  │   │
│  │ │    {id: "G3", deps: ["G2"], budget: {tokens: 6k, cost: $0.01}},       │  │   │
│  │ │  ]                                                                      │  │   │
│  │ │  dag: { G1 → G2 → G3 }                                                 │  │   │
│  │ │                                                                          │  │   │
│  │ │  CodeClaw 优势: 意图识别 + 子目标拆解                                   │  │   │
│  │ │  Claude Code: 无显式 Planner，单轮循环直接处理                           │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ Executor (DAG 调度器) — 【CodeClaw 核心差异化】                               │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  输入: dag (DependencyGraph)                                             │  │   │
│  │ │  输出: { completed: Task[], failed: Task[], gaps: Gap[] }               │  │   │
│  │ │                                                                          │  │   │
│  │ │  核心逻辑:                                                               │  │   │
│  │ │  1. topologicalSort(dag) → executionOrder                               │  │   │
│  │ │  2. 按顺序执行 (并行无依赖子任务)                                         │  │   │
│  │ │  3. 每子任务:                                                           │  │   │
│  │ │     · Agent Loop (buildCtx → callModel → toolExec → autoCompact)        │  │   │
│  │ │     · CostTracker 记录 (token/时间/金钱)                                 │  │   │
│  │ │     · 失败重试 (max 3 次)                                               │  │   │
│  │ │  4. 收集结果: completed/failed                                           │  │   │
│  │ │                                                                          │  │   │
│  │ │  CodeClaw 优势: 跨子任务的长程调度                                        │  │   │
│  │ │  Claude Code: 无 DAG 调度，单轮循环                                     │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ Reflector (Gap Analysis 引擎) — 【CodeClaw 核心差异化】                       │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  输入: expectedGoals, actualResults                                      │  │   │
│  │ │  输出: { gaps: Gap[], newGoals?: Goal[] }                               │  │   │
│  │ │                                                                          │  │   │
│  │ │  核心逻辑:                                                               │  │   │
│  │ │  1. compare(expectedGoals, actualResults) → gaps                       │  │   │
│  │ │  2. 对每个 gap:                                                          │  │   │
│  │ │     · 分析原因 (未执行? 执行错误? 遗漏?)                                │  │   │
│  │ │     · 生成修复策略                                                       │  │   │
│  │ │     · 生成新的子目标 (回传 Planner)                                      │  │   │
│  │ │  3. 返回 gaps + newGoals (如果未全覆盖)                                  │  │   │
│  │ │                                                                          │  │   │
│  │ │  闭环逻辑:                                                               │  │   │
│  │ │  while (gaps.length > 0) {                                              │  │   │
│  │ │    newGoals = planner.plan(gaps)                                         │  │   │
│  │ │    result = executor.execute(newGoals)                                   │  │   │
│  │ │    gaps = result.gaps                                                    │  │   │
│  │ │    if (gaps.every(g => g.severity < threshold)) break                   │  │   │
│  │ │  }                                                                       │  │   │
│  │ │                                                                          │  │   │
│  │ │  CodeClaw 优势: 自主纠偏 + 闭环交付                                      │  │   │
│  │ │  Claude Code: 无 Reflector，执行完即返回                                │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ Agent Loop (核心状态机) — 对齐 Claude Code query.ts (1,729 行)                │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  每轮迭代 (作为 Executor 的子任务执行):                                   │  │   │
│  │ │                                                                          │  │   │
│  │ │  while (true) {                                                         │  │   │
│  │ │    1. buildContext()         // 构建完整请求上下文                        │  │   │
│  │ │       · prependUserContext(messages)                                    │  │   │
│  │ │       · prependSystemContext()                                          │  │   │
│  │ │       · getAttachmentMessages()  // 中间命令/记忆注入                    │  │   │
│  │ │       · startMemoryPrefetch()  // 异步不阻塞                            │  │   │
│  │ │       · startSkillDiscoveryPrefetch()  // 异步不阻塞                    │  │   │
│  │ │                                                                          │  │   │
│  │ │    2. autoCompact()        // 压缩前检查                                 │  │   │
│  │ │       · L1 proactive: tokenCount > threshold?                           │  │   │
│  │ │         → 压缩最旧消息 → LLM 生成摘要 → CompactBoundaryMsg             │  │   │
│  │ │       · L2 reactive: 413 恢复                                           │  │   │
│  │ │       · L3 snip: /compact 用户触发                                      │  │   │
│  │ │       · 返回 compactionResult 或 null                                   │  │   │
│  │ │                                                                          │  │   │
│  │ │    3. checkBlockingLimit() // 阻塞限制检查                               │  │   │
│  │ │       · tokenCountWithEstimation() > maxContextWindow?                  │  │   │
│  │ │         → 返回 blocking_limit → return                                 │  │   │
│  │ │                                                                          │  │   │
│  │ │    4. callModel()          // 流式调用 LLM API                          │  │   │
│  │ │       · 调用 Provider (Anthropic/OpenAI/Ollama/LMStudio)               │  │   │
│  │ │       · 解析流式响应:                                                    │  │   │
│  │ │         → text_delta → yield (流式输出)                                 │  │   │
│  │ │         → tool_call_delta → collectToolUses()                           │  │   │
│  │ │         → stream_end → complete                                         │  │   │
│  │ │       · Model Fallback:                                                 │  │   │
│  │ │         → 高负载/限流 → switchModel(fallbackModel)                      │  │   │
│  │ │         → stripSignatureBlocks() → retry                               │  │   │
│  │ │                                                                          │  │   │
│  │ │    5. StreamingToolExecutor / runTools() // 工具执行                    │  │   │
│  │ │       · 解析 tool_use blocks                                             │  │   │
│  │ │       · 执行工具 (并行/串行 取决于 isConcurrencySafe)                    │  │   │
│  │ │       · 收集 tool_results                                                │  │   │
│  │ │       · 返回 toolUpdates (包含 message + newContext)                    │  │   │
│  │ │                                                                          │  │   │
│  │ │    6. handleStopHooks()  // 停止钩子执行                                 │  │   │
│  │ │       · executeStopHooks(messages, assistantMessages)                    │  │   │
│  │ │       → preventContinuation / blockingErrors                            │  │   │
│  │ │                                                                          │  │   │
│  │ │    7. checkTokenBudget() // Token 预算检查                               │  │   │
│  │ │       · checkTokenBudget() → continue/warn/stop                         │  │   │
│  │ │       · taskBudget 跨 compact 边界追踪                                   │  │   │
│  │ │                                                                          │  │   │
│  │ │    8. decide continue/return                                             │  │   │
│  │ │       · needsFollowUp (有 tool_use)? → continue                         │  │   │
│  │ │       · !needsFollowUp → return { reason: 'completed' }                │  │   │
│  │ │       · turnCount > maxTurns → return { reason: 'max_turns' }          │  │   │
│  │ │                                                                          │  │   │
│  │ │    状态转换:                                                              │  │   │
│  │ │    · 'next_turn' → 正常下一轮                                            │  │   │
│  │ │    · 'autocompact' → 压缩后继续                                          │  │   │
│  │ │    · 'reactive_compact' → 响应式压缩后继续                               │  │   │
│  │ │    · 'collapse_drain_retry' → 折叠回收后继续                             │  │   │
│  │ │    · 'max_output_tokens_recovery' → 输出token恢复                        │  │   │
│  │ │    · 'stop_hook_blocking' → 停止钩子阻塞                                 │  │   │
│  │ │    · 'token_budget_continuation' → token预算继续                         │  │   │
│  │ │                                                                          │  │   │
│  │ │    终止原因:                                                              │  │   │
│  │ │    · 'completed' → 模型完成, 无 tool_use                                 │  │   │
│  │ │    · 'blocking_limit' → 达到阻塞限制                                     │  │   │
│  │ │    · 'aborted_streaming' → 流式中断                                      │  │   │
│  │ │    · 'aborted_tools' → 工具执行中中断                                    │  │   │
│  │ │    · 'max_turns' → 达到最大轮次                                          │  │   │
│  │ │    · 'stop_hook_prevented' → 钩子阻止继续                                │  │   │
│  │ │    · 'hook_stopped' → 钩子停止                                           │  │   │
│  │ │    · 'model_error' → API 错误                                            │  │   │
│  │ │    · 'image_error' → 图片错误                                            │  │   │
│  │ │    · 'token_budget' → token 预算耗尽                                     │  │   │
│  │ │                                                                          │  │   │
│  │ │    状态对象:                                                              │  │   │
│  │ │    {                                                                    │  │   │
│  │ │      messages: Message[],                // 当前消息集                   │  │   │
│  │ │      toolUseContext: ToolUseContext,       // 工具执行上下文             │  │   │
│  │ │      autoCompactTracking: AutoCompactTrackingState,  // 压缩跟踪         │  │   │
│  │ │      maxOutputTokensRecoveryCount: number,   // 输出token恢复计数(max 3) │  │   │
│  │ │      hasAttemptedReactiveCompact: boolean,   // 已尝试响应式压缩         │  │   │
│  │ │      maxOutputTokensOverride: number | undefined, // 输出token覆盖值     │  │   │
│  │ │      pendingToolUseSummary: Promise<...> | undefined, // 异步工具摘要    │  │   │
│  │ │      stopHookActive: boolean | undefined,    // 停止钩子活跃状态         │  │   │
│  │ │      turnCount: number,                    // 当前轮次                   │  │   │
│  │ │      transition: { reason: string } | undefined // 上次 continue 的原因  │  │   │
│  │ │    }                                                                    │  │   │
│  │ │                                                                          │  │   │
│  │ │  状态转换矩阵:                                                            │  │   │
│  │ │  ┌──────────────────────────┬────────────────────────────────────────┐   │  │   │
│  │ │  │ continue 原因             │ 触发条件                                 │   │  │   │
│  │ │  ├──────────────────────────┼────────────────────────────────────────┤   │  │   │
│  │ │  │ 'next_turn'             │ 正常工具执行完成, 有 tool_result          │   │  │   │
│  │ │  │ 'autocompact'           │ proactive auto-compact 后                 │   │  │   │
│  │ │  │ 'reactive_compact'      │ reactive compact 后 (413 恢复)           │   │  │   │
│  │ │  │ 'collapse_drain_retry'  │ contextCollapse 回收后重试                │   │  │   │
│  │ │  │ 'max_output_tokens_reco│ max_output_tokens 超限, 恢复消息注入      │   │  │   │
│  │ │  │                          │ (最多 3 次)                               │   │  │   │
│  │ │  │ 'stop_hook_blocking'    │ 停止钩子返回 blocking errors              │   │  │   │
│  │ │  │ 'token_budget_cont.     │ tokenBudget action = 'continue'          │   │  │   │
│  │ │  └──────────────────────────┴────────────────────────────────────────┘   │  │   │
│  │ │                                                                          │  │   │
│  │ │  continue 条件:                                                           │  │   │
│  │ │  ┌────────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ 当以下条件任一为真时 continue:                                      │  │  │   │
│  │ │  │  · needsFollowUp (有 tool_use)                                    │  │  │   │
│  │ │  │  · recoveryMessage 注入 (max_output_tokens)                       │  │  │   │
│  │ │  │  · stopHook blocking errors                                       │  │  │   │
│  │ │  │  · tokenBudget action = 'continue'                                │  │  │   │
│  │ │  │  且 turnCount <= maxTurns                                         │  │  │   │
│  │ │  └────────────────────────────────────────────────────────────────────┘  │  │   │
│  │ │                                                                          │  │   │
│  │ │  终止条件:                                                               │  │   │
│  │ │  ┌────────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ 当以下条件任一为真时 return:                                        │  │  │   │
│  │ │  │  · !needsFollowUp + !recoveryMessage + !blockingErrors +          │  │  │   │
│  │ │  │    budget 不继续                                                    │  │  │   │
│  │ │  │  · turnCount > maxTurns                                           │  │  │   │
│  │ │  │  · abort signal 触发                                              │  │  │   │
│  │ │  │  · stopHook preventContinuation = true                            │  │  │   │
│  │ │  │  · hook stopped continuation = true                               │  │  │   │
│  │ │  │  · model_error / image_error / blocking_limit                     │  │  │   │
│  │ │  └────────────────────────────────────────────────────────────────────┘  │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ ApprovalManager (审批流管理) — 【CodeClaw 核心差异化】                        │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  CodeClaw 优势: 完整的审批流生命周期管理                                  │  │   │
│  │ │  Claude Code: 简单的审批/UI 提示                                         │  │   │
│  │ │                                                                          │  │   │
│  │ │  审批流全生命周期:                                                        │  │   │
│  │ │  ┌────────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ Phase 1: 创建审批 (createApproval)                                 │  │  │   │
│  │ │  │  · 检测需要审批的操作 (权限矩阵 deny/ask)                           │  │  │   │
│  │ │  │  · 生成审批请求 { id, tool, input, riskLevel }                     │  │  │   │
│  │ │  │  · 存储审批状态 (pending → waiting for user response)               │  │  │   │
│  │ │  │  · 通知用户 (CLI TUI / 微信消息 / WS event)                       │  │  │   │
│  │ │  │  · 设置超时 (默认 5min, 可配置)                                   │  │  │   │
│  │ │  └────────────────────────────────────────────────────────────────────┘  │  │   │
│  │ │                                                                          │  │   │
│  │ │  ┌────────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ Phase 2: 响应审批 (respondToApproval)                             │  │  │   │
│  │ │  │  · 接收审批响应 (approve/deny/pending)                             │  │  │   │
│  │ │  │  · 更新审批状态                                                     │  │  │   │
│  │ │  │  · approve → continue 执行工具                                     │  │  │   │
│  │ │  │  · deny → 记录拒绝，继续下一个操作                                   │  │  │   │
│  │ │  │  · pending → 等待，继续执行其他工具                                 │  │  │   │
│  │ │  └────────────────────────────────────────────────────────────────────┘  │  │   │
│  │ │                                                                          │  │   │
│  │ │  ┌────────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ Phase 3: 超时处理 (handleTimeout)                                 │  │  │   │
│  │ │  │  · 超时 → 自动降级 (deny → safe fallback)                         │  │  │   │
│  │ │  │  · 重试策略 (max 3 次)                                            │  │  │   │
│  │ │  │  · 记录超时事件到审计日志                                           │  │  │   │
│  │ │  └────────────────────────────────────────────────────────────────────┘  │  │   │
│  │ │                                                                          │  │   │
│  │ │  ┌────────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ Phase 4: 恢复 (recover)                                            │  │  │   │
│  │ │  │  · 断连后恢复审批状态 (从持久化存储加载)                              │  │  │   │
│  │ │  │  · 恢复审批通知 (重新发送给用户)                                    │  │  │   │
│  │ │  │  · 恢复工具执行队列 (继续执行待处理工具)                              │  │  │   │
│  │ │  └────────────────────────────────────────────────────────────────────┘  │  │   │
│  │ │                                                                          │  │   │
│  │ │  审批状态机:                                                              │  │   │
│  │ │  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐              │  │   │
│  │ │  │   pending   │────▶│  waiting    │────▶│  approved   │──▶ 执行      │  │   │
│  │ │  │             │     │ for user    │     │ / denied    │    工具      │  │   │
│  │ │  └─────────────┘     └─────────────┘     └─────────────┘              │  │   │
│  │ │      ▲                │         │               │                      │  │   │
│  │ │      └────────────────┘         └───────────────┘                      │  │   │
│  │ │                   timeout        deny                                    │  │   │
│  │ │                                                                          │  │   │
│  │ │  审批记录:                                                                │  │   │
│  │ │  {                                                                      │  │   │
│  │ │    approvalId: string,                                                  │  │   │
│  │ │    toolName: string,                                                    │  │   │
│  │ │    toolInput: { [key: string]: unknown },                               │  │   │
│  │ │    riskLevel: 'low' | 'medium' | 'high' | 'critical',                  │  │   │
│  │ │    status: 'pending' | 'waiting' | 'approved' | 'denied' | 'timed_out'│  │   │
│  │ │    createdAt: number,                                                   │  │   │
│  │ │    respondedAt?: number,                                                │  │   │
│  │ │    respondedBy?: string,                                                │  │   │
│  │ │    response: 'approve' | 'deny' | 'pending' | null,                    │  │   │
│  │ │    timeoutMs: number,  // 默认 300000 (5min)                           │  │   │
│  │ │    retryCount: number,  // 默认 0                                      │  │   │
│  │ │  }                                                                      │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Layer 4: Engine Layer（引擎层）

**职责**：Provider 抽象、模型路由、成本追踪、Token 计算

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  Layer 4: Engine Layer                                                              │
│  ───────────────────────────────────────────────────────────────────────────────────  │
│  职责：Provider 抽象、模型路由、成本追踪、Token 计算                                   │
│  位置：src/core/                                                                    │
│                                                                                      │
│  CodeClaw 优势: 4 模型兼容 (Claude Code: Anthropic + 有限 OpenAI)                    │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ Provider 抽象层 — 【CodeClaw 核心差异化】                                      │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  抽象基类:                                                               │  │   │
│  │ │  abstract class Provider {                                              │  │   │
│  │ │    name: string;                                                         │  │   │
│  │ │    config: ProviderConfig;                                              │  │   │
│  │ │                                                                          │  │   │
│  │ │    abstract sendMessage(                                                 │  │   │
│  │ │      messages: Message[],                                                │  │   │
│  │ │      tools?: Tool[],                                                     │  │   │
│  │ │      options?: ProviderOptions                                           │  │   │
│  │ │    ): AsyncGenerator<ProviderStreamEvent>                                │  │   │
│  │ │                                                                          │  │   │
│  │ │    abstract getModels(): Promise<ModelInfo[]>                           │  │   │
│  │ │    abstract getLimits(): ProviderLimits                                  │  │   │
│  │ │  }                                                                      │  │   │
│  │ │                                                                          │  │   │
│  │ │  实现类 (4 个):                                                          │  │   │
│  │ │  ┌────────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ AnthropicProvider                                                  │  │  │   │
│  │ │  │ · Claude API (native fetch)                                        │  │  │   │
│  │ │  │ · 支持: Claude Sonnet/Opus/Haiku 系列                             │  │  │   │
│  │ │  │ · 特性: Thinking, Tool Use, Context Window 200k/400k              │  │  │   │
│  │ │  │ ──────────────────────────────────────────────────────────────────  │  │  │   │
│  │ │  │ OpenAIProvider                                                     │  │  │   │
│  │ │  │ · OpenAI 兼容 API (native fetch)                                   │  │  │   │
│  │ │  │ · 支持: GPT-4, GPT-3.5, 以及其他 OpenAI 兼容模型                  │  │  │   │
│  │ │  │ · 特性: Function Calling, Tool Use                                 │  │  │   │
│  │ │  │ ──────────────────────────────────────────────────────────────────  │  │  │   │
│  │ │  │ OllamaProvider                                                     │  │  │   │
│  │ │  │ · 本地 Ollama API (native fetch)                                   │  │  │   │
│  │ │  │ · 支持: Llama 3, Mistral, CodeLlama 等开源模型                     │  │  │   │
│  │ │  │ · 特性: 完全离线, 无 API Key, 成本为零                             │  │  │   │
│  │ │  │ ──────────────────────────────────────────────────────────────────  │  │  │   │
│  │ │  │ LMStudioProvider                                                   │  │  │   │
│  │ │  │ · 本地 LMStudio API (native fetch)                                 │  │  │   │
│  │ │  │ · 支持: 本地部署的开源/商业模型                                     │  │  │   │
│  │ │  │ · 特性: 完全离线, API Key 可选, 成本为零                           │  │  │   │
│  │ │  └────────────────────────────────────────────────────────────────────┘  │  │   │
│  │ │                                                                          │  │   │
│  │ │  流式事件:                                                               │  │   │
│  │ │  {                                                                      │  │   │
│  │ │    type: 'message_start' | 'text_delta' | 'tool_call_delta' |          │  │   │
│  │ │          'stream_end' | 'error' | 'usage'                             │  │   │
│  │ │    // ... 事件特定字段                                                   │  │   │
│  │ │  }                                                                      │  │   │
│  │ │                                                                          │  │   │
│  │ │  CodeClaw 优势: 4 模型兼容 vs Claude Code 的 Anthropic 优先            │  │   │
│  │ │  支持完全离线部署 (Ollama/LMStudio)                                     │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ ModelRouter (模型路由) + FallbackManager (回退管理)                            │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  决策逻辑:                                                               │  │   │
│  │ │  getRecommendedModel(): string {                                        │  │   │
│  │ │    // 1. 用户指定 model? → 直接用                                        │  │   │
│  │ │    // 2. permissionMode = 'plan'? → plan 模型                           │  │   │
│  │ │    // 3. agentId? → 子代理用更便宜的模型 (成本优化)                      │  │   │
│  │ │    // 4. 检查 provider 可用 model 列表                                  │  │   │
│  │ │    // 5. fallbackModel? → 使用 fallback                                │  │   │
│  │ │    // 6. 默认 → mainLoopModel                                           │  │   │
│  │ │  }                                                                      │  │   │
│  │ │                                                                          │  │   │
│  │ │  FallbackManager:                                                       │  │   │
│  │ │  · 检测 API 返回高负载/限流                                              │  │   │
│  │ │  · 自动降级到 fallbackModel                                              │  │   │
│  │ │  · stripSignatureBlocks() → 移除 thinking 签名避免 400 错误             │  │   │
│  │ │  · logEvent('tengu_model_fallback_triggered', {...})                     │  │   │
│  │ │  · yield createSystemMessage('Switched to X due to high demand', 'warning')│  │   │
│  │ │  · retry 当前请求                                                        │  │   │
│  │ │                                                                          │  │   │
│  │ │  回退链:                                                                │  │   │
│  │ │  model1 → model2 → model3 → ... → final fallback                       │  │   │
│  │ │  (最多回退 3 次，超过则返回错误)                                         │  │   │
│  │ │                                                                          │  │   │
│  │ │  CodeClaw 优势: 多模型回退链 (Anthropic → OpenAI → Ollama → LMStudio) │  │   │
│  │ │  Claude Code: Anthropic → 有限 fallback                                │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ CostTracker (成本追踪) — 【CodeClaw 核心差异化】                               │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  追踪维度:                                                               │  │   │
│  │ │  · 每请求 (per-request): input/output/cache tokens + 成本                │  │   │
│  │ │  · 每 session: 累计 tokens + 成本                                        │  │   │
│  │ │  · 全局: 所有 session 累计                                               │  │   │
│  │ │  · 每模型: 按模型分组的成本统计                                            │  │   │
│  │ │                                                                          │  │   │
│  │ │  APIUsage {                                                             │  │   │
│  │ │    input_tokens: number;                                                │  │   │
│  │ │    output_tokens: number;                                               │  │   │
│  │ │    cache_read_input_tokens: number;                                    │  │   │
│  │ │    cache_creation_input_tokens: number;                                │  │   │
│  │ │    cost_usd: number;                                                    │  │   │
│  │ │  }                                                                      │  │   │
│  │ │                                                                          │  │   │
│  │ │  查询接口:                                                               │  │   │
│  │ │  getTotalCost(): string  // 格式化 $XX.XX                               │  │   │
│  │ │  getUsage(): APIUsage                                                   │  │   │
│  │ │  getModelUsage(): Map<string, APIUsage>  // 按模型拆分                   │  │   │
│  │ │  getTotalAPIDuration(): number  // ms                                   │  │   │
│  │ │  getTotalCost(): number  // USD                                         │  │   │
│  │ │                                                                          │  │   │
│  │ │  预算告警:                                                               │  │   │
│  │ │  · tokenBudget action = 'warn' → 触发预算告警                           │  │   │
│  │ │  · tokenBudget action = 'stop' → 触发预算上限                           │  │   │
│  │ │  · costTracker.addNotification() → 通知用户                             │  │   │
│  │ │                                                                          │  │   │
│  │ │  /cost 命令:                                                             │  │   │
│  │ │  输出:                                                                   │  │   │
│  │ │  ┌───────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ Session: $0.0234 (4,521 input, 1,234 output, 890 cache)       │  │  │   │
│  │ │  │ Model:   $0.0123 (Anthropic) / $0.0111 (OpenAI)                │  │  │   │
│  │ │  │ Total:   $0.1567 (28,102 input, 8,901 output, 5,432 cache)   │  │  │   │
│  │ │  │ Duration: 12m 34s                                                │  │  │   │
│  │ │  │ Turns:  15 (avg 48.3s)                                          │  │  │   │
│  │ │  └───────────────────────────────────────────────────────────────────┘  │  │   │
│  │ │                                                                          │  │   │
│  │ │  CodeClaw 优势: 多模型成本对比 + 预算告警                                │  │   │
│  │ │  Claude Code: 仅单模型成本追踪                                          │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ TokenCalculator (Token 计算)                                                  │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  关键方法:                                                               │  │   │
│  │ │                                                                          │  │   │
│  │ │  tokenCountWithEstimation(messages: Message[]): number                  │  │   │
│  │ │    // 基于模型估算 token 数 (fast, 非精确)                               │  │   │
│  │ │    // 用于: 压缩阈值检查、阻塞限制检查                                    │  │   │
│  │ │                                                                          │  │   │
│  │ │  finalContextTokensFromLastResponse(messages: Message[]): number        │  │   │
│  │ │    // 计算最后一个 assistant message 的上下文 token                       │  │   │
│  │ │    // 用于: taskBudget 跨 compact 计算                                   │  │   │
│  │ │                                                                          │  │   │
│  │ │  calculateTokenWarningState(                                            │  │   │
│  │ │    tokenCount: number,                                                  │  │   │
│  │ │    model: string,                                                       │  │   │
│  │ │  ): { isAtBlockingLimit: boolean; warningLevel: 'none'|'warn'|'limit' } │  │   │
│  │ │    // 计算 token 警告状态:                                              │  │   │
│  │ │    · none: < 80% threshold (安全)                                       │  │   │
│  │ │    · warn: 80-95% threshold (警告)                                      │  │   │
│  │ │    · limit: > 95% threshold (接近阻塞)                                   │  │   │
│  │ │                                                                          │  │   │
│  │ │  getContextWindowForModel(model: string): number                        │  │   │
│  │ │    // 获取模型上下文窗口 (Claude: 200k, Haiku: 32k, Opus: 400k)         │  │   │
│  │ │                                                                          │  │   │
│  │ │  getMaxOutputTokens(model: string): number                              │  │   │
│  │ │    // 获取模型最大输出 token                                             │  │   │
│  │ │                                                                          │  │   │
│  │ │  阈值计算 (对齐 Claude Code):                                           │  │   │
│  │ │  ┌───────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ threshold = contextWindow                                         │  │  │   │
│  │ │  │              - reservedForSummary(20k)                             │  │  │   │
│  │ │  │              - buffer(13k)                                        │  │  │   │
│  │ │  │              - maxOutputTokens                                     │  │  │   │
│  │ │  │                                                                   │  │  │   │
│  │ │  │ claude-sonnet-4-6 (200k): 200k - 20k - 13k - 8k = 159k         │  │  │   │
│  │ │  │ claude-haiku (32k):       32k - 20k - 13k - 4k = -5k (不触发)   │  │  │   │
│  │ │  │ claude-opus (400k):      400k - 20k - 13k - 8k = 359k          │  │  │   │
│  │ │  └───────────────────────────────────────────────────────────────────┘  │  │   │
│  │ │                                                                          │  │   │
│  │ │  TokenBudget 检查:                                                      │  │   │
│  │ │  {                                                                      │  │   │
│  │ │    action: 'continue' | 'warn' | 'stop';                              │  │   │
│  │ │    continuationCount?: number;    // continue 次数                      │  │   │
│  │ │    pct?: number;            // token 使用百分比                         │  │   │
│  │ │    nudgeMessage?: string;   // 用户提示消息                             │  │   │
│  │ │    completionEvent?: {                                              │  │   │
│  │ │      diminishingReturns: boolean;                                    │  │   │
│  │ │      pct: number;                                                    │  │   │
│  │ │    };                                                                  │  │   │
│  │ │  }                                                                      │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Layer 5: Cognitive Layer（认知层）

**职责**：上下文管理、压缩策略、三层记忆系统

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  Layer 5: Cognitive Layer                                                             │
│  ───────────────────────────────────────────────────────────────────────────────────  │
│  职责：上下文管理、压缩策略、三层记忆系统                                                   │
│  位置：src/cognitive/                                                                 │
│                                                                                      │
│  CodeClaw 优势: 三层记忆系统 (Claude Code: Rolling Buffer + 压缩)                      │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ ContextWindow Manager (上下文窗口管理器)                                      │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  核心职责:                                                               │  │   │
│  │ │  · 管理 200k 上下文窗口 (claude-sonnet-4-6)                             │  │   │
│  │ │  · 协调 Auto-Compact 多层压缩                                           │  │   │
│  │ │  · 管理 L1/L2/L3 记忆层次                                              │  │   │
│  │ │  · Token 估算和预算追踪                                                │  │   │
│  │ │                                                                          │  │   │
│  │ │  上下文窗口状态:                                                         │  │   │
│  │ │  {                                                                      │  │   │
│  │ │    contextWindow: number;          // 模型上下文窗口大小                 │  │   │
│  │ │    currentTokens: number;        // 当前使用 token 数                   │  │   │
│  │ │    availableTokens: number;      // 可用 token 数                        │  │   │
│  │ │    threshold: number;            // 压缩触发阈值                         │  │   │
│  │ │    reservedTokens: number;       // 为输出保留的 token (20k + 13k)      │  │   │
│  │ │    messages: Message[];          // 当前消息集                           │  │   │
│  │ │    fileStateCache: FileStateCache;  // 文件状态缓存                      │  │   │
│  │ │  }                                                                      │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ Auto-Compact 多层压缩系统 (对齐 Claude Code services/compact/)                  │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  五层压缩架构 (对齐 Claude Code):                                       │  │   │
│  │ │                                                                          │  │   │
│  │ │  ┌────────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ L1: Proactive Auto-Compact (压缩前检查)                           │  │  │   │
│  │ │  │ • 触发: tokenCountWithEstimation() > threshold                   │  │  │   │
│  │ │  │ • 机制: 压缩最旧消息 → LLM 生成摘要 → CompactBoundaryMsg         │  │  │   │
│  │ │  │ • 阈值: contextWindow - reservedForSummary(20k)                 │  │  │   │
│  │ │  │ • 指标: 10+ 项 (originalMessageCount, preCompactTokenCount 等)   │  │  │   │
│  │ │  │ • 失败处理: consecutiveFailures++ → 3次失败后停止                 │  │  │   │
│  │ │  └────────────────────────────────────────────────────────────────────┘  │  │   │
│  │ │                                                                          │  │   │
│  │ │  ┌────────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ L2: Reactive Compact (API 413 响应式压缩)                         │  │  │   │
│  │ │  │ • 触发: API 返回 413 (prompt too long)                           │  │  │   │
│  │ │  │ • 机制: 压缩最旧消息直到 under 阈值 (最多 5 次)                   │  │  │   │
│  │ │  │ • Media Recovery: 剥离图片/PDF 等大媒体文件                        │  │  │   │
│  │ │  └────────────────────────────────────────────────────────────────────┘  │  │   │
│  │ │                                                                          │  │   │
│  │ │  ┌────────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ L3: Snip Compact (用户触发 /compact)                              │  │  │   │
│  │ │  │ • 触发: 用户输入 /compact <token_limit>                           │  │  │   │
│  │ │  │ • 机制: 按 token 预算贪心选择                                      │  │  │   │
│  │ │  └────────────────────────────────────────────────────────────────────┘  │  │   │
│  │ │                                                                          │  │   │
│  │ │  ┌────────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ L4: Context Collapse (实验性, feature('CONTEXT_COLLAPSE'))        │  │  │   │
│  │ │  │ • 机制: 不丢失信息的紧凑表示 (折叠 staged collapses)                │  │  │   │
│  │ │  └────────────────────────────────────────────────────────────────────┘  │  │   │
│  │ │                                                                          │  │   │
│  │ │  ┌────────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ L5: Micro-Compact (实验性, feature('CACHED_MICROCOMPACT'))       │  │  │   │
│  │ │  │ • 触发: API 返回 cache_deleted_input_tokens > 0                  │  │  │   │
│  │ │  │ • 机制: 同步 API cache 删除，保持客户端一致                        │  │  │   │
│  │ │  └────────────────────────────────────────────────────────────────────┘  │  │   │
│  │ │                                                                          │  │   │
│  │ │  ┌────────────────────────────────────────────────────────────────────┐  │  │   │
│  │ │  │ Max Output Tokens Recovery (输出 token 恢复)                       │  │  │   │
│  │ │  │ • 触发: isMaxOutputTokensError(lastMessage)                        │  │  │   │
│  │ │  │ • 机制: 最多 3 次 recoveryMessage + continue                       │  │  │   │
│  │ │  └────────────────────────────────────────────────────────────────────┘  │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ Session Memory Manager (三层记忆系统) — 【CodeClaw 核心差异化】                │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  L1: Rolling Buffer (最近 N 条消息)                                     │  │   │
│  │ │  · 保持最近 N 条消息在内存中 (默认: 100 条或 80% 上下文)                 │  │   │
│  │ │  · 超出部分由 Auto-Compact L1 处理                                       │  │   │
│  │ │  · 优化: readFileState (文件状态缓存) — 避免重复读取文件                  │  │   │
│  │ │                                                                          │  │   │
│  │ │  L2: Session Memory (压缩摘要持久化)                                     │  │   │
│  │ │  · CompactBoundaryMessage 中的压缩摘要持久化                              │  │   │
│  │ │  · JSONL/SQLite 存储，支持跨会话加载                                     │  │   │
│  │ │  · 压缩前: 记录原始消息的元数据 (消息类型、工具调用、时间戳)               │  │   │
│  │ │  · 压缩后: 存储摘要 + 元数据 → 支持精确恢复                              │  │   │
│  │ │  · 压缩指标: 10+ 项 (originalMessageCount, preCompactTokenCount 等)      │  │   │
│  │ │                                                                          │  │   │
│  │ │  L3: Codebase RAG (代码库索引 + 向量检索) — 【CodeClaw 核心差异化】      │  │   │
│  │ │  · 代码库文件 → BM25 索引 (快速关键词匹配)                               │  │   │
│  │ │  · bge-m3 embedding → 向量存储 (语义检索)                                │  │   │
│  │ │  · 混合检索: BM25 score + cosine similarity                              │  │   │
│  │ │  · 增量更新: 文件修改触发索引更新                                         │  │   │
│  │ │  · 索引范围: src/、lib/、config/ (排除 node_modules/.git)               │  │   │
│  │ │                                                                          │  │   │
│  │ │  CodeClaw 优势: L3 使 Agent 理解整个代码库结构                           │  │   │
│  │ │  Claude Code: 无 L3 代码库索引                                           │  │   │
│  │ │                                                                          │  │   │
│  │ │  记忆加载时机:                                                            │  │   │
│  │ │  · Agent Loop 每轮: startRelevantMemoryPrefetch()                       │  │   │
│  │ │  · 异步预加载: memoryAttachments + skillDiscoveryAttachments             │  │   │
│  │ │  · 中间注入: getAttachmentMessages() → 注入为 tool_results                │  │   │
│  │ │                                                                          │  │   │
│  │ │  记忆类型:                                                               │  │   │
│  │ │  · memory_attachment: L2 Session Memory 摘要                            │  │   │
│  │ │  · skill_attachment: 技能发现结果                                        │  │   │
│  │ │  · edited_text_file: 文件修改跟踪                                        │  │   │
│  │ │  · compact_summary: 压缩摘要                                             │  │   │
│  │ │  · hook_stopped: 钩子停止通知                                           │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Layer 6: Capability Layer（能力层）

**职责**：Command 系统、工具系统、技能系统、钩子系统、插件系统、Intent 系统

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  Layer 6: Capability Layer                                                           │
│  ───────────────────────────────────────────────────────────────────────────────────  │
│  职责：Command 系统(113)、工具系统(40+)、技能系统、钩子系统、插件系统、Intent 系统    │
│  位置：src/capabilities/                                                              │
│                                                                                      │
│  CodeClaw 优势: 5 层扩展生态 (Claude Code: Tool + Plugin + Hook)                     │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ Command 系统 (对齐 Claude Code commands.ts + src/commands/)                    │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  Command 注册与发现:                                                     │  │   │
│  │ │  getBuiltinCommands(): Command[]  // 113 个内建命令                      │  │   │
│  │ │  getSkillDirCommands(dir: string): Command[]  // 技能目录命令            │  │   │
│  │ │  getPluginCommands(dirs: string[]): Command[]  // 插件命令               │  │   │
│  │ │  getDynamicSkills(): Command[]  // 动态技能命令                          │  │   │
│  │ │  getCommands(): Command[]  // 合并所有源                                 │  │   │
│  │ │  getCommandsByMaxPriority(priority: 'next' | 'later'): Command[]         │  │   │
│  │ │                                                                          │  │   │
│  │ │  命令优先级:                                                             │  │   │
│  │ │  · priority = 'next' → 中间注入 (立即执行)                              │  │   │
│  │ │  · priority = 'later' → 轮次结束注入                                    │  │   │
│  │ │                                                                          │  │   │
│  │ │  113 个命令 12 大分类:                                                 │  │   │
│  │ │  · 核心/生命周期 (15): /exit, /clear, /resume, /help, /version,        │  │   │
│  │ │    /cost, /usage, /status, /compact, ...                                │  │   │
│  │ │  · 上下文/记忆 (12): /model, /mode, /effort, /fast, /context,          │  │   │
│  │ │    /add-dir, /ctx-viz, /memory, /plan, ...                              │  │   │
│  │ │  · 代码操作 (15): /review, /autofix-pr, /commit-push-pr,               │  │   │
│  │ │    /branch, /issue, /pr-comments, /code-review, ...                     │  │   │
│  │ │  · 权限/安全 (6): /permissions, /sandbox-toggle, /pass,                │  │   │
│  │ │    /privacy-settings, /rate-limit-options, /reset-limits               │  │   │
│  │ │  · MCP/插件 (8): /mcp, /plugin, /providers, /agents,                   │  │   │
│  │ │    /skills, /hooks, /reload-plugins, /install-github-app               │  │   │
│  │ │  · 配置/UI (10): /config, /theme, /color, /output-style,               │  │   │
│  │ │    /keybindings, /statusline, /terminal-setup, /ide, ...                │  │   │
│  │ │  · 桥接/远程 (8): /bridge, /teleport, /remote-env,                     │  │   │
│  │ │    /remote-setup, /desktop, /mobile, /chrome                            │  │   │
│  │ │  · 调试/诊断 (12): /debug-tool-call, /insights, /perf-issue,           │  │   │
│  │ │    /ant-trace, /heapdump, /mock-limits, /backfill-sessions             │  │   │
│  │ │  · 社交 (5): /good-claude, /feedback, /stickers, /btw, /buddy          │  │   │
│  │ │  · Kairos/高级 (5): /assistant, /brief, /proactive,                    │  │   │
│  │ │    /subscribe-pr, /workflows                                            │  │   │
│  │ │  · Voice (1): /voice                                                   │  │   │
│  │ │  · Skills/初始化 (2): /skills, /init                                   │  │   │
│  │ │                                                                          │  │   │
│  │ │  Command 类型:                                                           │  │   │
│  │ │  · type: 'prompt' → getPromptForCommand() → LLM 处理                   │  │   │
│  │ │  · type: 'local'  → run() → 本地执行                                    │  │   │
│  │ │  · type: 'streaming' → stream() → 流式输出                              │  │   │
│  │ │  · type: 'task-notification' → 注入给子代理                              │  │   │
│  │ │                                                                          │  │   │
│  │ │  命令实现目录:                                                            │  │   │
│  │ │  src/commands/                                                           │  │   │
│  │ │  ├── core/ (/exit, /clear, /resume, /help, /version, /cost, ...)       │  │   │
│  │ │  ├── context/ (/model, /mode, /effort, /compact, /memory, ...)         │  │   │
│  │ │  ├── code/ (/review, /autofix-pr, /commit-push-pr, ...)                │  │   │
│  │ │  ├── permission/ (/permissions, /sandbox-toggle, /pass, ...)           │  │   │
│  │ │  ├── mcp-plugins/ (/mcp, /plugin, /providers, ...)                    │  │   │
│  │ │  ├── config-ui/ (/config, /theme, /color, ...)                         │  │   │
│  │ │  ├── bridge-remote/ (/bridge, /teleport, /remote-env, ...)             │  │   │
│  │ │  ├── debug-diag/ (/debug-tool-call, /insights, ...)                   │  │   │
│  │ │  ├── social/ (/good-claude, /feedback, /stickers, ...)                │  │   │
│  │ │  ├── kairo-advanced/ (/assistant, /brief, /proactive, ...)             │  │   │
│  │ │  ├── voice/ (/voice)                                                   │  │   │
│  │ │  └── init/ (/skills, /init, /init-verifiers)                          │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ 工具系统 (对齐 Claude Code Tool.ts + tools.ts)                                │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  buildTool 工厂模式:                                                     │  │   │
│  │ │  const TOOL_DEFAULTS = {                                                │  │   │
│  │ │    isEnabled: () => true,                                               │  │   │
│  │ │    isConcurrencySafe: () => false,  // 默认不并发安全                    │  │   │
│  │ │    isReadOnly: () => false,   // 默认非只读                              │  │   │
│  │ │    isDestructive: () => false,  // 默认非破坏性                          │  │   │
│  │ │    checkPermissions: (input) => Promise.resolve({                       │  │   │
│  │ │      behavior: 'allow', updatedInput: input                             │  │   │
│  │ │    }),                                                                  │  │   │
│  │ │    toAutoClassifierInput: () => '',  // 跳过 classifier                 │  │   │
│  │ │    userFacingName: () => '',                                            │  │   │
│  │ │  };                                                                     │  │   │
│  │ │  function buildTool<D extends ToolDef>(def: D): BuiltTool<D> {          │  │   │
│  │ │    return { ...TOOL_DEFAULTS, userFacingName: () => def.name, ...def }; │  │   │
│  │ │  }                                                                      │  │   │
│  │ │                                                                          │  │   │
│  │ │  40+ 内建工具 (tools.ts):                                                │  │   │
│  │ │  · AgentTool (子代理创建)                                               │  │   │
│  │ │  · BashTool (本地 Shell 命令)                                           │  │   │
│  │ │  · FileReadTool (文件读取)                                              │  │   │
│  │ │  · FileWriteTool (文件写入)                                             │  │   │
│  │ │  · FileEditTool (文件编辑)                                              │  │   │
│  │ │  · GlobTool (文件模式匹配)                                              │  │   │
│  │ │  · GrepTool (文本搜索)                                                  │  │   │
│  │ │  · WebFetchTool (网页抓取)                                              │  │   │
│  │ │  · WebSearchTool (网页搜索)                                             │  │   │
│  │ │  · TodoWriteTool (Todo 管理)                                            │  │   │
│  │ │  · SkillTool (技能触发)                                                 │  │   │
│  │ │  · LSPTool (代码库符号查询) — 【CodeClaw 核心差异化】                   │  │   │
│  │ │  · IntentParser (意图解析器) — 【CodeClaw 核心差异化】                  │  │   │
│  │ │  ... (更多)                                                              │  │   │
│  │ │                                                                          │  │   │
│  │ │  工具过滤: filterToolsByDenyRules()                                     │  │   │
│  │ │  根据 permissionContext.alwaysDenyRules 过滤被 deny 的工具               │  │   │
│  │ │                                                                          │  │   │
│  │ │  CodeClaw 优势: LSPTool + IntentParser                                 │  │   │
│  │ │  Claude Code: 无 LSPTool + 无 IntentParser                              │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ Intent System (意图系统) — 【CodeClaw 核心差异化】                             │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │  CodeClaw 独有优势: 意图识别 + 分类 + 路由                                │  │   │
│  │ │  Claude Code: 无意图识别，直接执行命令                                    │  │   │
│  │ │                                                                          │  │   │
│  │ │  IntentParser:                                                           │  │   │
│  │ │  · 解析用户输入为结构化意图                                               │  │   │
│  │ │  · 识别: 代码文件/函数/模块/依赖关系                                      │  │   │
│  │ │  · 输出: { type, entities, constraints, confidence }                    │  │   │
│  │ │                                                                          │  │   │
│  │ │  IntentClassifier:                                                       │  │   │
│  │ │  · 分类意图类型: task/query/create/fix/analyze                           │  │   │
│  │ │  · 基于意图选择对应 Executor 策略                                         │  │   │
│  │ │                                                                          │  │   │
│  │ │  IntentRouter:                                                           │  │   │
│  │ │  · 路由到 Planner (task) / Reflector (analyze) / DirectResponse (query)  │  │   │
│  │ │                                                                          │  │   │
│  │ │  意图识别流程:                                                            │  │   │
│  │ │  用户输入 → IntentParser.parse → IntentClassifier.classify →            │  │   │
│  │ │  IntentRouter.route → Planner/Reflector/DirectResponse                  │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ 技能系统 + 钩子系统 + 插件系统 + MCP                                          │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │ 技能系统 (Skills):                                                       │  │   │
│  │ · 加载: .codeclaw/skills/ 目录下的 SKILL.md 文件                          │  │   │
│  │ · 动态发现: getSlashCommandToolSkills(dir) + getDynamicSkills()           │  │   │
│  │ · 技能预加载: startSkillDiscoveryPrefetch() 异步触发                       │  │   │
│  │ · 注入: collectSkillDiscoveryPrefetch() → skill_attachment                │  │   │
│  │                                                                          │  │   │
│  │ 钩子系统 (Hooks):                                                        │  │   │
│  │ · 7 种生命周期钩子: pre/post_tool_use, pre/post_compact,                 │  │   │
│  │   session_start, pre/post_stream                                         │  │   │
│  │ · 注册: .codeclaw/hooks/ 目录下的 hook 脚本                               │  │   │
│  │ · 执行: executePostSamplingHooks() / executeStopHooks()                   │  │   │
│  │                                                                          │  │   │
│  │ 插件系统 (Plugins):                                                      │  │   │
│  · 3 类插件: 内建/用户/Marketplace                                          │  │   │
│  · 加载: .codeclaw/plugins/ + Marketplace                                   │  │   │
│  · 命令集成: getPluginCommands(dirs) → 注册插件命令                           │  │   │
│  · 清理: cleanupOrphanedPluginVersionsInBackground()                         │  │   │
│  │                                                                          │  │   │
│  │ MCP 集成 (MCP Servers):                                                  │  │   │
│  │ · 传输: stdio / SSE (参考 @anthropic-ai/mcpb)                            │  │   │
│  │ · 连接管理: MCPServerConnection[]                                         │  │   │
│  │ · 工具发现: getMcpToolsCommandsAndResources()                             │  │   │
│  │ · 资源预取: prefetchOfficialMcpUrls() / prefetchAllMcpResources()        │  │   │
│  │ · MCP 工具: ListMcpResourcesTool / ReadMcpResourceTool                   │  │   │
│  │ · MCP 工具注入: mcpTools: appState.mcp.tools                             │  │   │
│  │                                                                          │  │   │
│  │ 能力发现链:                                                              │  │   │
│  │ 用户输入 → 技能匹配 → 插件命令 → MCP 工具 → Intent 路由 → 内建工具      │  │   │
│  │                                                                          │  │   │
│  │ CodeClaw 优势: Intent 路由 (Claude Code 无此层)                           │  │   │
│  │ 5 层扩展生态 vs Claude Code 的 3 层 (Tool + Plugin + Hook)              │  │   │
│  └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Layer 7: Infrastructure Layer（基础设施层）

**职责**：权限系统、审计日志、国际化、日志、遥测、配置、Bootstrap

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  Layer 7: Infrastructure Layer                                                       │
│  ───────────────────────────────────────────────────────────────────────────────────  │
│  职责：权限、审计、i18n、日志、遥测、配置、Bootstrap                                  │
│  位置：src/infra/ + src/bootstrap/ + src/permission/                                  │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ 权限系统 (Permission System)                                                  │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │ 6 种权限模式 (PermissionMode):                                           │  │   │
│  │ │ · 'default' → 每次询问                                                   │  │   │
│  │ │ · 'plan' → 先给计划, 再执行                                              │  │   │
│  │ │ · 'auto' → 自动批准低风险只读/安全操作                                   │  │   │
│  │ │ · 'acceptEdits' → 自动批准文件编辑                                       │  │   │
│  │ │ · 'bypassPermissions' → 开发者调试模式                                   │  │   │
│  │ │ · 'dontAsk' → 自动化运行, 永远不问                                       │  │   │
│  │ │                                                                          │  │   │
│  │ │ 权限矩阵 (每操作):                                                        │  │   │
│  │ │ · allow → 直接执行                                                       │  │   │
│  │ │ · ask → 显示审批 UI                                                      │  │   │
│  │ │ · deny → 拒绝执行                                                        │  │   │
│  │ │                                                                          │  │   │
│  │ │ 规则来源优先级 (高→低):                                                  │  │   │
│  │ │ 1. CLI 参数 (最高优先级)                                                 │  │   │
│  │ │ 2. flagSettings (运行时设置)                                             │  │   │
│  │ │ 3. policySettings (策略设置)                                             │  │   │
│  │ │ 4. project 项目配置                                                      │  │   │
│  │ │ 5. user 用户配置                                                         │  │   │
│  │ │ 6. dynamic 动态规则 (运行时评估) (最低优先级)                              │  │   │
│  │ │                                                                          │  │   │
│  │ │ PermissionContext (不可变):                                              │  │   │
│  │ │ {                                                                      │  │   │
│  │ │   mode: PermissionMode,                                                │  │   │
│  │ │   alwaysAllowRules: ToolPermissionRulesBySource,  // 始终允许          │  │   │
│  │ │   alwaysDenyRules: ToolPermissionRulesBySource,   // 始终拒绝         │  │   │
│  │ │   alwaysAskRules: ToolPermissionRulesBySource,    // 始终询问        │  │   │
│  │ │   isBypassPermissionsModeAvailable: boolean,                            │  │   │
│  │ │   isAutoModeAvailable?: boolean,                                        │  │   │
│  │ │   strippedDangerousRules?: ToolPermissionRulesBySource,                 │  │   │
│  │ │   shouldAvoidPermissionPrompts?: boolean,                               │  │   │
│  │ │   awaitAutomatedChecksBeforeDialog?: boolean,                           │  │   │
│  │ │   prePlanMode?: PermissionMode  // 计划模式前的权限模式                 │  │   │
│  │ │ }                                                                      │  │   │
│  │ │                                                                          │  │   │
│  │ │ PermissionResult:                                                        │  │   │
│  │ │ {                                                                      │  │   │
│  │ │   behavior: 'allow' | 'ask' | 'deny';                                 │  │   │
│  │ │   updatedInput?: { [key: string]: unknown };                          │  │   │
│  │ │   denyReason?: string;                                                  │  │   │
│  │ │ }                                                                      │  │   │
│  │ │                                                                          │  │   │
│  │ │ DenialTracking (拒绝跟踪):                                              │  │   │
│  │ │ · 记录工具拒绝事件: tool_name, tool_use_id, tool_input                  │  │   │
│  │ │ · 用于 SDK 返回 permission_denials                                      │  │   │
│  │ │ · 用于分析高频被拒绝的工具                                                │  │   │
│  │ └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ 审计日志 (AuditLog) + 日志 (Logger)                                           │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │ AuditLog (审计日志):                                                     │  │   │
│  │ · 格式: JSONL (追加写入)                                                   │  │   │
│  │ · 位置: ~/.codeclaw/audit/                                               │  │   │
│  │ · 内容: 工具调用、权限决策、API 请求/响应摘要                               │  │   │
│  │ · 生命周期: 每日轮换                                                        │  │   │
│  │ · 敏感信息: 脱敏 (API key, 文件内容)                                       │  │   │
│  │                                                                          │  │   │
│  │ Logger (日志):                                                           │  │   │
│  │ · 使用 pino (JSON 结构化日志)                                             │  │   │
│  │ · 级别: debug / info / warn / error                                     │  │   │
│  │ · 输出: STDOUT (CLI 模式) / file (daemon 模式)                           │  │   │
│  │ · 性能: headlessProfilerCheckpoint() 追踪关键路径性能                      │  │   │
│  │ · 错误收集: getInMemoryErrors() + errorLogWatermark 水印                   │  │   │
│  │                                                                          │  │   │
│  │ logError() vs logAntError():                                             │  │   │
│  │ · logError() — 通用错误日志                                               │  │   │
│  │ · logAntError() — 内部错误日志 (更详细, 仅 ant 模式)                      │  │   │
│  └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ i18n (国际化) + Telemetry (遥测)                                              │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │ i18n (国际化):                                                           │  │   │
│  │ · 库: i18next                                                              │  │   │
│  │ · 语言: zh-CN / en-US                                                      │  │   │
│  │ · 动态切换: getLanguage() / setLanguage()                                  │  │   │
│  │ · 上下文感知: 根据 channel/language 偏好自动选择                             │  │   │
│  │ · 翻译策略: 用户可见文本翻译, 技术术语保留英文                               │  │   │
│  │                                                                          │  │   │
│  │ Telemetry (遥测):                                                          │  │   │
│  │ · 库: logEvent() + logForDebugging()                                     │  │   │
│  │ · 事件类型:                                                              │  │   │
│  │   · tengu_auto_compact_succeeded — 压缩成功                                │  │   │
│  │   · tengu_reactive_compact — 响应式压缩                                    │  │   │
│  │   · tengu_query_started/completed/error — 查询生命周期                     │  │   │
│  │   · tengu_streaming_tool_execution_used — 流式工具执行                     │  │   │
│  │   · tengu_model_fallback_triggered — 模型降级                              │  │   │
│  │   · tengu_token_budget_completed — Token 预算完成                          │  │   │
│  │   · tengu_orphaned_messages_tombstoned — 孤儿消息墓碑                      │  │   │
│  │   · ... (30+ 事件类型)                                                    │  │   │
│  │ · 上报方式: 异步上报, 不影响核心路径                                        │  │   │
│  │ · 数据: 非敏感 (token 计数, 工具名称, 错误类型)                             │  │   │
│  │ · 隐私: 用户可关闭遥测 (CLAUDE_CODE_TELEMETRY=false)                       │  │   │
│  └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ 配置系统 (Config) + Bootstrap (引导)                                          │   │
│  │ ┌───────────────────────────────────────────────────────────────────────────┐  │   │
│  │ │                                                                          │  │   │
│  │ │ 配置系统 (Config):                                                       │  │   │
│  │ · 格式: YAML (config.yaml) + JSON (providers.json)                        │  │   │
│  │ · 位置: ~/.codeclaw/config.yaml, ~/.codeclaw/providers.json                │  │   │
│  │ · 内容: Provider 配置、默认模型、权限模式、主题、快捷键                      │  │   │
│  │ · 加载: loadAllConfigFiles() → 合并优先级: user > project > default        │  │   │
│  │ · 热更新: settingsChangeDetector() — 监听配置变更                           │  │   │
│  │                                                                          │  │   │
│  │ Bootstrap (引导系统):                                                    │  │   │
│  │ · 9步引导流程:                                                           │  │   │
│  │   1. profileCheckpoint('main_tsx_entry') — 启动性能追踪                   │  │   │
│  │   2. startMdmRawRead() — MDM 策略读取                                   │  │   │
│  │   3. startKeychainPrefetch() — macOS 钥匙串预取                            │  │   │
│  │   4. resolveEarlyProvider() — 早期 Provider 解析                           │  │   │
│  │   5. initializeGrowthBook() — 特性标志初始化                              │  │   │
│  │   6. fetchBootstrapData() — 远程引导数据                                  │  │   │
│  │   7. loadPolicyLimits() — 策略限制加载                                   │  │   │
│  │   8. resolveBootstrapRuntimeProfile() — 运行时配置                         │  │   │
│  │   9. showSetupScreens() → launchRepl() / QueryEngine()  — UI 启动        │  │   │
│  │ · 性能目标: 冷启动 < 500ms (不含网络)                                    │  │   │
│  │ · 性能关键: profileCheckpoint/profileReport 追踪各阶段耗时                 │  │   │
│  └───────────────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.4 数据流设计

#### 2.4.1 请求处理完整数据流

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  请求处理完整数据流 (从用户输入到结果输出)                                                     │
│                                                                                              │
│  ╔══════════════════════════════════════════════════════════════════════════════════════════╗ │
│  ║  Phase 1: 接入与路由 (Layer 1 → Layer 2)                                               ║ │
│  ╠══════════════════════════════════════════════════════════════════════════════════════════╣ │
│  ║  用户输入 (CLI/WS/HTTP/微信/MCP)                                                        ║ │
│  ║       │                                                                                  ║ │
│  ║       ▼                                                                                  ║ │
│  ║  ┌─────────────────┐                                                                  ║ │
│  ║  │ Channel Adapter  │  适配各渠道输入格式                                                 ║ │
│  ║  │ (Layer 1)       │                                                                  ║ │
│  ║  └────────┬────────┘                                                                  ║ │
│  ║           │                                                                            ║ │
│  ║           ▼                                                                            ║ │
│  ║  ┌──────────────────────────────────────────────────────────────────────────────┐     ║ │
│  ║  │ Ingress Gateway (Layer 2)                                                    │     ║ │
│  ║  │                                                                              │     ║ │
│  ║  │  Step 1: SessionManager                                                      │     ║ │
│  ║  │  · (channel:userId) → sessionId (唯一标识)                                   │     ║ │
│  ║  │  · SessionState 持久化: session.json + transcript.jsonl + fileHistory/      │     ║ │
│  ║  │                                                                              │     ║ │
│  ║  │  Step 2: PriorityRouter                                                      │     ║ │
│  ║  │  · highPriority → 立即处理 (中断当前)                                        │     ║ │
│  ║  │  · normalPriority → 排队等待 (非阻塞)                                        │     ║ │
│  ║  │                                                                              │     ║ │
│  ║  │  Step 3: PermitGate                                                          │     ║ │
│  ║  │  · permissionMode = 'auto': 直接放行                                         │     ║ │
│  ║  │  · permissionMode = 'plan': 需审批 (UI 卡片)                                 │     ║ │
│  ║  │  · permissionMode = 'default': 首次需审批                                    │     ║ │
│  ║  └──────────────────────────────────────────────────────────────────────────────┘     │     ║ │
│  ╚══════════════════════════════════════════════════════════════════════════════════════════╝  │
│                                                                                              │
│  ╔══════════════════════════════════════════════════════════════════════════════════════════╗ │
│  ║  Phase 2: 编排层执行 (Layer 3: Planner → Executor → Reflector)                         ║ │
│  ╠══════════════════════════════════════════════════════════════════════════════════════════╣ │
│  ║                                                                                        ║ │
│  ║  启动引擎: QueryEngine (SDK) 或 launchRepl (CLI)                                        ║ │
│  ║                                                                                        ║ │
│  ║  ╔══════════════════════════════════════════════════════════════════════════════════╗   ║ │
│  ║  ║ [CodeClaw 核心差异: 长程任务编排]                                                 ║   ║ │
│  ║  ║                                                                                  ║   ║ │
│  ║  ║  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                          ║   ║ │
│  ║  ║  │ Planner     │──▶│ Executor    │──▶│ Reflector   │                          ║   ║ │
│  ║  ║  │ (目标拆解)  │   │ (DAG 调度)  │   │ (Gap Analysis)│                          ║   ║ │
│  ║  ║  └─────────────┘    └─────────────┘    └─────────────┘                          ║   ║ │
│  ║  ║       │                  │                    │                                  ║   ║ │
│  ║  ║       │  gaps > 0        │  gaps > 0          │  gaps = 0                        ║   ║ │
│  ║  ║       │◀─────────────────┘                    │                                  ║   ║ │
│  ║  ║       │                                     ▼                                  ║   ║ │
│  ║  ║       │                          返回最终结果                                  ║   ║ │
│  ║  ║  ╚══════════════════════════════════════════════════════════════════════════════╝   ║ │
│  ║                                                                                        ║ │
│  ║  详细流程:                                                                             ║ │
│  ║                                                                                        ║ │
│  ║  ┌───────────────────────────────────────────────────────────────────────────────┐    ║ │
│  ║  │ Step 1: Planner (目标拆解)                                                     │    ║ │
│  ║  │ · IntentParser.parse(userInput) → Intent { type, entities, constraints }      │    ║ │
│  ║  │ · IntentClassifier.classify(intent) → Strategy                                 │    ║ │
│  ║  │ · DAG Generator → { goals: Goal[], dag: DependencyGraph, costEstimate }       │    ║ │
│  ║  └───────────────────────────────────────────────────────────────────────────────┘    ║ │
│  ║                                                                                        ║ │
│  ║  ┌───────────────────────────────────────────────────────────────────────────────┐    ║ │
│  ║  │ Step 2: Executor (DAG 调度)                                                   │    ║ │
│  ║  │ · topologicalSort(dag) → executionOrder                                        │    ║ │
│  ║  │ · 并行执行无依赖子任务                                                           │    ║ │
│  ║  │ · 每子任务 → Agent Loop (buildCtx → callModel → toolExec → autoCompact)        │    ║ │
│  ║  │ · CostTracker 记录 (token/时间/金钱)                                            │    ║ │
│  ║  │ · 失败重试 (max 3 次)                                                           │    ║ │
│  ║  │ · 返回 { completed: Task[], failed: Task[], gaps: Gap[] }                      │    ║ │
│  ║  └───────────────────────────────────────────────────────────────────────────────┘    ║ │
│  ║                                                                                        ║ │
│  ║  ┌───────────────────────────────────────────────────────────────────────────────┐    ║ │
│  ║  │ Step 3: Reflector (Gap Analysis)                                              │    ║ │
│  ║  │ · compare(expectedGoals, actualResults) → gaps                               │    ║ │
│  ║  │ · 对每个 gap 分析原因 + 生成修复策略 + 新子目标                                 │    ║ │
│  ║  │ · 返回 { gaps: Gap[], newGoals?: Goal[] }                                    │    ║ │
│  ║  │                                                                              ║ │
│  ║  │ 闭环逻辑:                                                                    ║ │
│  ║  │ while (gaps.length > 0) {                                                   ║ │
│  ║  │   newGoals = planner.plan(gaps)                                              ║ │
│  ║  │   result = executor.execute(newGoals)                                        ║ │
│  ║  │   gaps = result.gaps                                                         ║ │
│  ║  │   if (gaps.every(g => g.severity < threshold)) break                        ║ │
│  ║  │ }                                                                            ║ │
│  ║  └───────────────────────────────────────────────────────────────────────────────┘    ║ │
│  ║                                                                                        ║ │
│  ╚══════════════════════════════════════════════════════════════════════════════════════════╝  │
│                                                                                              │
│  ╔══════════════════════════════════════════════════════════════════════════════════════════╗ │
│  ║  Phase 3: 结果输出 (Layer 1)                                                           ║ │
│  ╠══════════════════════════════════════════════════════════════════════════════════════════╣ │
│  ║  流式输出: StreamEvent → yield → Channel Adapter → 渠道输出                              ║ │
│  ║  最终结果: ResultMessage (stop_reason, num_turns, usage, cost, permission_denials)       ║ │
│  ║  recordTranscript() — 会话持久化                                                        ║ │
│  ║  logEvent() — 遥测上报 (Layer 7)                                                       ║ │
│  ╚══════════════════════════════════════════════════════════════════════════════════════════╝  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### 2.4.2 核心数据对象

**IngressMessage (Layer 1 → 2)**:

```typescript
type IngressMessage = {
  channel: 'cli' | 'sdk' | 'wechat' | 'mcp' | 'http'
  userId: string
  sessionId: string | null  // 由 IngressGateway 映射
  input: string | ContentBlockParam[]  // 用户输入
  priority: 'high' | 'normal'
  timestamp: number
  metadata: {
    transport?: 'stdio' | 'ws' | 'sse' | 'rest' | 'stdin'
    source?: 'user' | 'hook' | 'command' | 'system'
    parentToolUseId?: string
    isInterrupt?: boolean
    channelSpecific?: Record<string, unknown>
  }
}
```

**Message (Layer 4 内部消息类型)**:

```typescript
type Message =
  | UserMessage       // type: 'user'
  | AssistantMessage  // type: 'assistant'
  | SystemMessage     // type: 'system'
  | AttachmentMessage // type: 'attachment'
  | TombstoneMessage  // type: 'tombstone'

type UserMessage = {
  type: 'user'
  message: {
    content: TextBlockParam[]
    usage?: APIUsage
  }
  uuid: string
  timestamp: number
  isMeta: boolean      // 合成消息 (如 compact_boundary)
  toolUseResult?: string
  parentToolUseId?: string
  session_id?: string
  isReplay?: boolean
  isSynthetic?: boolean
}

type AssistantMessage = {
  type: 'assistant'
  message: {
    content: (TextBlockParam | ToolUseBlockParam | ToolResultBlockParam)[]
    usage?: APIUsage
  }
  uuid: string
  timestamp: number
  isApiErrorMessage?: boolean
  apiError?: 'max_output_tokens' | 'prompt_too_long'
  session_id?: string
}

type CompactBoundaryMessage = {
  type: 'system'
  subtype: 'compact_boundary'
  compactMetadata: {
    preCompactTokenCount: number
    postCompactTokenCount: number
    truePostCompactTokenCount: number
    compactionUsage: {
      input_tokens: number
      output_tokens: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
    originalMessageCount: number
    compactedMessageCount: number
    queryChainId: string
    queryDepth: number
  }
  compactSummaryMessage: string
}
```

**SDKMessage (Layer 2 → 1 流转对象)**:

```typescript
type SDKMessage =
  | { type: 'stream_request_start' }
  | { type: 'stream_event'; event: StreamEvent }
  | { type: 'message'; message: Message }
  | { type: 'compact_boundary'; compactMetadata: CompactMetadata }
  | { type: 'tool_use_summary'; summary: ToolUseSummaryMessage }
  | {
      type: 'result'
      subtype: 'success' | 'error_during_execution'
      is_error: boolean
      duration_ms: number
      duration_api_ms: number
      num_turns: number
      stop_reason: string | null
      result: string
      session_id: string
      total_cost_usd: number
      usage: APIUsage
      modelUsage: Map<string, APIUsage>
      permission_denials: SDKPermissionDenial[]
      structured_output?: string
      fast_mode_state: FastModeState
      uuid: string
      errors?: string[]  // diagnostic prefix
    }
  | { type: 'permission_denial'; denial: SDKPermissionDenial }
```

**State (Agent Loop 循环状态)**:

```typescript
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: { reason: string } | undefined
}
```

#### 2.4.3 Agent Loop 状态转换图

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  Agent Loop 状态转换图 (query.ts)                                                     │
│                                                                                      │
│  ┌────────────────────────────────────────────────────────────────────────────┐     │
│  │  初始状态: State {                                                          │     │
│  │    messages: params.messages,                                              │     │
│  │    turnCount: 1,                                                           │     │
│  │    transition: undefined,                                                   │     │
│  │    maxOutputTokensRecoveryCount: 0,                                         │     │
│  │    hasAttemptedReactiveCompact: false,                                      │     │
│  │    autoCompactTracking: undefined,                                          │     │
│  │    pendingToolUseSummary: undefined,                                        │     │
│  │    stopHookActive: undefined,                                               │     │
│  │    maxOutputTokensOverride: undefined                                       │     │
│  │  }                                                                         │     │
│  └────────────────────────┬──────────────────────────────────────────────────┘     │
│                           │                                                          │
│                           ▼                                                          │
│  ┌────────────────────────────────────────────────────────────────────────────┐     │
│  │  [while(true) Loop]                                                       │     │
│  │                                                                           │     │
│  │  每轮迭代流程:                                                              │     │
│  │  ┌────────────┐   ┌─────────────┐   ┌──────────────┐                    │     │
│  │  │ buildCtx  │ → │ autoCompact │ → │ callModel   │                    │     │
│  │  └────────────┘   └─────────────┘   └──────┬───────┘                    │     │
│  │                                              │                              │     │
│  │                                              ▼                              │     │
│  │                                       ┌───────────────┐                     │     │
│  │                                       │ toolExecute   │                     │     │
│  │                                       └───────┬───────┘                     │     │
│  │                                               │                              │     │
│  │                                               ▼                              │     │
│  │                                       ┌───────────────┐                     │     │
│  │                                       │ handleStop    │                     │     │
│  │                                       │ checkBudget   │                     │     │
│  │                                       └───────┬───────┘                     │     │
│  │                                               │                              │     │
│  │                        ┌──────────────────────┼──────────────────────┐      │     │
│  │                        │                      │                       │      │     │
│  │                        ▼                      ▼                       ▼      │     │
│  │                   {continue}             {completed}               {aborted}  │     │
│  │                   更新 state             return {reason}            return      │     │
│  │                   ────────────────────────────────────────────────────▶        │     │
│  │                   │                                                            │     │
│  │                   └────────────────────────────────────────────────────────────┘     │
│  │                                                                                      │
│  │  状态转换矩阵:                                                                        │
│  │  ┌──────────────────────────┬──────────────────────────────────────────────────┐   │     │
│  │  │ continue 原因             │ 触发条件                                          │   │     │
│  │  ├──────────────────────────┼──────────────────────────────────────────────────┤   │     │
│  │  │ 'next_turn'             │ 正常工具执行完成, 有 tool_result                   │   │     │
│  │  │ 'autocompact'           │ proactive auto-compact 后                          │   │     │
│  │  │ 'reactive_compact'      │ reactive compact 后 (413 恢复)                    │   │     │
│  │  │ 'collapse_drain_retry'  │ contextCollapse 回收后重试                         │   │     │
│  │  │ 'max_output_tokens_reco│ max_output_tokens 超限, 恢复消息注入 (最多 3 次)   │   │     │
│  │  │ 'stop_hook_blocking'    │ 停止钩子返回 blocking errors                      │   │     │
│  │  │ 'token_budget_cont.     │ tokenBudget action = 'continue'                   │   │     │
│  │  └──────────────────────────┴──────────────────────────────────────────────────┘   │     │
│  │                                                                                      │
│  │  终止原因:                                                                            │
│  │  · 'completed' → 模型完成, 无 tool_use                                              │
│  │  · 'blocking_limit' → 达到阻塞限制                                                   │
│  │  · 'aborted_streaming' → 流式中断                                                   │
│  │  · 'aborted_tools' → 工具执行中中断                                                  │
│  │  · 'max_turns' → 达到最大轮次                                                       │
│  │  · 'stop_hook_prevented' → 钩子阻止继续                                             │
│  │  · 'hook_stopped' → 钩子停止                                                        │
│  │  · 'model_error' → API 错误                                                        │
│  │  · 'image_error' → 图片错误                                                         │
│  │  · 'token_budget' → token 预算耗尽                                                  │
│  └────────────────────────────────────────────────────────────────────────────┘     │
│                                                                                      │
│  continue 条件总结:                                                                    │
│  ┌────────────────────────────────────────────────────────────────────────────┐     │
│  │ 当以下条件任一为真时 continue:                                             │
│  │  · needsFollowUp (有 tool_use)                                            │
│  │  · recoveryMessage 注入 (max_output_tokens)                              │
│  │  · stopHook blocking errors                                              │
│  │  · tokenBudget action = 'continue'                                       │
│  │  且 turnCount <= maxTurns                                                │
│  └────────────────────────────────────────────────────────────────────────────┘     │
│                                                                                      │
│  终止条件总结:                                                                       │
│  ┌────────────────────────────────────────────────────────────────────────────┐     │
│  │ 当以下条件任一为真时 return:                                               │
│  │  · !needsFollowUp + !recoveryMessage + !blockingErrors + budget 不继续   │
│  │  · turnCount > maxTurns                                                   │
│  │  · abort signal 触发                                                      │
│  │  · stopHook preventContinuation = true                                    │
│  │  · hook stopped continuation = true                                       │
│  │  · model_error / image_error / blocking_limit                            │
│  └────────────────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### 2.4.4 数据流设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| **状态传递** | `state = next` 对象替换 | 避免 7 个独立变量赋值，对齐 Claude Code |
| **消息流** | AsyncGenerator 流式输出 | 支持 token-by-token 推送 + 递归调用 |
| **Session 映射** | `channel:userId → sessionId` | 唯一标识，支持跨会话恢复 |
| **优先级路由** | high/normal 两档 | MVP 简化，Phase 3 可扩展到 4 档 |
| **压缩决策** | 压缩前检查 > 压缩后恢复 | proactive 预防优于 reactive 补救 |
| **Token 预算** | checkTokenBudget + taskBudget 双轨 | 本地预算 + API task_budget 跨 compact |
| **中断处理** | AbortController.signal | 标准 API，支持流式和工具执行中断 |
| **消息持久化** | JSONL 追加写入 | MVP 简单，Phase 1.9 迁移 SQLite |
| **遥测上报** | logEvent 异步上报 | 非阻塞，不影响核心性能 |

### 2.5 目录结构

```
codeclaw/
├── package.json
├── tsconfig.json
├── .codeclaw/              # 用户配置目录
│   ├── config.yaml          # 主配置
│   ├── providers.json       # Provider 配置
│   ├── sessions/            # Session 持久化 (JSONL)
│   ├── hooks/               # 用户钩子
│   ├── skills/              # 用户技能
│   └── plugins/             # 用户插件
├── src/
│   ├── main.tsx             # REPL 引导程序
│   ├── query.ts             # Agent Loop 核心 (对齐 query.ts 1,729行)
│   ├── QueryEngine.ts       # SDK 查询生命周期
│   ├── Tool.ts              # 工具接口 + buildTool 工厂
│   ├── Task.ts              # 任务基类
│   ├── tools.ts             # 工具注册与过滤
│   ├── commands.ts          # Command 注册与获取
│   ├── setup.ts             # 首次启动引导
│   ├── replLauncher.tsx     # REPL 启动器
│   ├── dialogLaunchers.tsx  # 对话框组件
│   ├── interactiveHelpers.tsx # 交互辅助
│   ├── cost-tracker.ts      # 成本追踪
│   ├── history.ts           # 会话历史
│   ├── context.ts           # 上下文管理
│   ├── projectContext.ts    # 项目上下文
│   ├── tokenCalculations.ts # Token 计算
│   ├── contextWindow.ts     # 上下文窗口
│   ├── systemPromptBuilder.ts # 系统提示词构建
│   ├── toolResult.ts        # 工具结果
│   ├── outputFormatting.ts  # 输出格式化
│   ├── inputMessages.ts     # 输入消息
│   ├── systemPrompt.ts      # 系统提示
│   ├── queryContext.ts      # 查询上下文
│   ├── queryHelpers.ts      # 查询辅助
│   ├── queryProfiler.ts     # 查询性能分析
│   ├── query/
│   │   ├── transitions.ts   # 查询状态转换
│   │   ├── tokenBudget.ts   # Token 预算
│   │   ├── deps.ts          # 查询依赖
│   │   ├── config.ts        # 查询配置
│   │   ├── stopHooks.ts     # 停止钩子
│   │   └── streaming.ts     # 流式处理
│   ├── bootstrap/           # Layer 7: Bootstrap (启动引导)
│   ├── bridge/              # Layer 7: 会话桥接
│   ├── coordinator/         # 多代理协调
│   ├── proactive/           # 主动通知
│   ├── assistant/           # 助手模式
│   ├── voice/               # 语音
│   ├── ingress/             # Layer 2: 入口层
│   │   ├── gateway.ts       # IngressGateway 主入口
│   │   ├── sessionManager.ts # Session 映射管理
│   │   ├── priorityRouter.ts # 优先级路由
│   │   ├── messageBuffer.ts  # 消息缓冲
│   │   └── permitGate.ts    # 权限预检
│   ├── channels/            # Layer 1: 接入层
│   │   ├── cli/             # CLI REPL Channel
│   │   ├── sdk/             # SDK/HTTP Channel
│   │   ├── wechat/          # 微信 Bot Channel
│   │   ├── mcp/             # MCP External Channel
│   │   └── channelAdapter.ts # 渠道适配器
│   ├── orchestration/       # Layer 3: 编排层
│   │   ├── planner/         # Planner (目标拆解)
│   │   │   ├── intentParser.ts # IntentParser
│   │   │   ├── intentClassifier.ts # IntentClassifier
│   │   │   ├── goalPlanner.ts # 子目标拆解
│   │   │   └── dagGenerator.ts # DAG 生成
│   │   ├── executor/        # Executor (DAG 调度)
│   │   │   ├── scheduler.ts # DAG 调度器
│   │   │   ├── taskRunner.ts # 子任务执行
│   │   │   └── retry.ts    # 失败重试
│   │   ├── reflector/       # Reflector (Gap Analysis)
│   │   │   ├── gapAnalyzer.ts # Gap 分析
│   │   │   └── goalReplanner.ts # 重新规划
│   │   ├── approvalMgr/     # ApprovalManager
│   │   │   ├── approvalStore.ts # 审批存储
│   │   │   ├── timeoutHandler.ts # 超时处理
│   │   │   └── recovery.ts # 恢复
│   │   ├── queryEngine.ts   # QueryEngine
│   │   ├── agentLoop.ts     # Agent Loop
│   │   └── toolScheduler.ts  # 工具调度器
│   ├── core/                # Layer 4: 引擎层
│   │   ├── provider/        # Provider 抽象
│   │   │   ├── base.ts      # Provider 基类
│   │   │   ├── anthropic.ts # Anthropic Provider
│   │   │   ├── openai.ts    # OpenAI Provider
│   │   │   ├── ollama.ts    # Ollama Provider
│   │   │   └── lmstudio.ts  # LMStudio Provider (CodeClaw 独有)
│   │   ├── modelRouter.ts   # 模型路由
│   │   ├── fallbackManager.ts # 回退管理
│   │   └── costTracker.ts   # 成本追踪
│   ├── cognitive/           # Layer 5: 认知层
│   │   ├── contextWindow/
│   │   │   ├── manager.ts   # 上下文窗口管理
│   │   │   └── autoCompact.ts  # L1 Proactive Auto-Compact
│   │   ├── reactiveCompact/   # L2 Reactive Compact
│   │   ├── snipCompact/       # L3 Snip Compact
│   │   ├── contextCollapse/   # L4 Context Collapse
│   │   ├── microCompact/      # L5 Micro-Compact
│   │   └── sessionMemory/
│   │       ├── l1Buffer.ts   # L1 Rolling Buffer
│   │       ├── l2Session.ts  # L2 Session Memory
│   │       └── l3Rag.ts      # L3 Codebase RAG (CodeClaw 独有)
│   ├── capabilities/        # Layer 6: 能力层
│   │   ├── command/         # Command 系统
│   │   │   ├── registry.ts  # 命令注册表
│   │   │   ├── runner.ts    # 命令执行引擎
│   │   │   └── injection.ts # 中间注入
│   │   ├── tools/           # 工具系统
│   │   │   ├── buildTool.ts  # 工具工厂
│   │   │   ├── agent/       # Agent 工具
│   │   │   ├── bash/        # Bash 工具
│   │   │   ├── read/        # FileRead 工具
│   │   │   ├── write/       # FileWrite 工具
│   │   │   ├── edit/        # FileEdit 工具
│   │   │   ├── glob/        # Glob 工具
│   │   │   ├── grep/        # Grep 工具
│   │   │   └── lsp/         # LSPTool (CodeClaw 独有)
│   │   ├── intent/          # Intent 系统 (CodeClaw 独有)
│   │   │   ├── intentParser.ts
│   │   │   ├── intentClassifier.ts
│   │   │   └── intentRouter.ts
│   │   ├── skill/           # 技能系统
│   │   ├── hook/            # 钩子系统
│   │   ├── plugin/          # 插件系统
│   │   └── mcp/             # MCP 集成
│   ├── infra/               # Layer 7: 基础设施层
│   │   ├── permission/      # 权限系统
│   │   │   ├── gate.ts      # PermissionGate
│   │   │   └── modes.ts     # 6种权限模式
│   │   ├── audit/           # 审计日志
│   │   ├── i18n/            # 国际化
│   │   ├── logger/          # 日志
│   │   ├── telemetry/       # 遥测
│   │   ├── config/          # 配置系统
│   │   └── state/           # 全局状态
│   ├── types/               # 类型定义
│   ├── ink/                 # Ink TUI 组件
│   ├── components/          # React UI 组件
│   └── utils/               # 通用工具函数
│
├── tests/
│   ├── unit/
│   └── integration/
│
├── docs/
│   ├── DESIGN.md
│   ├── FEATURE_DESIGN.md
│   ├── TECH_DESIGN.md
│   ├── VER_0.5_DEV_TASKS.md
│   └── tech-design/
│       └── VER_0.5_TECH_DESIGN.md ← 本文档
│
├── scripts/
│   ├── build.mjs            # esbuild 打包
│   ├── build-bun.mjs        # Bun 内建打包
│   └── prepare-src.mjs      # 源码准备
│
└── stubs/
    ├── bun-bundle.ts        # feature() 桩
    ├── macros.ts            # 编译时宏
    └── global.d.ts
```

---

## 三、核心组件设计

### 3.1 Planner（目标拆解引擎）

**输入**: userGoal (string)  
**输出**: `{ goals: Goal[], dag: DependencyGraph, costEstimate: Budget }`

```typescript
// IntentParser.parse → Intent { type, entities, constraints }
// IntentClassifier.classify → Strategy
// DAG Generator → { goals: Goal[], dag: DependencyGraph }

type Intent = {
  type: 'task' | 'query' | 'create' | 'fix' | 'analyze'
  entities: { files: string[], functions: string[], modules: string[] }
  constraints: { timeLimit?: number, budgetLimit?: number, qualityThreshold?: number }
  confidence: number  // 0.0-1.0
}

type Goal = {
  id: string
  description: string
  deps: string[]  // 依赖的子目标 ID
  budget: { tokens: number, cost: number, time: number }
  priority: number  // 优先级 (越大越优先)
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
}

type Strategy =
  | { type: 'dag-planning'; maxDepth: number }
  | { type: 'direct-response'; model: string }
  | { type: 'scaffolding'; pattern: string }
  | { type: 'diagnostic'; focus: string }
  | { type: 'analysis'; scope: string }
```

### 3.2 Executor (DAG 调度器)

**输入**: dag (DependencyGraph)  
**输出**: `{ completed: Task[], failed: Task[], gaps: Gap[] }`

```typescript
interface Executor {
  /** 执行 DAG，返回结果 */
  execute(dag: DependencyGraph): Promise<ExecutionResult>
}

interface ExecutionResult {
  completed: Task[]  // 成功完成的任务
  failed: Task[]     // 失败的任务
  gaps: Gap[]        // 未覆盖的 Gap
  cost: CostReport   // 成本报告
  duration: number   // 执行耗时 (ms)
}

interface Gap {
  id: string
  severity: 'low' | 'medium' | 'high'
  description: string
  rootCause: string
  suggestedFix: string
}
```

### 3.3 Reflector (Gap Analysis 引擎)

**输入**: expectedGoals, actualResults  
**输出**: `{ gaps: Gap[], newGoals?: Goal[] }`

```typescript
interface Reflector {
  /** 分析 Gap，返回新子目标 */
  analyze(expectedGoals: Goal[], actualResults: ExecutionResult): Promise<ReflectorResult>
}

interface ReflectorResult {
  gaps: Gap[]
  newGoals: Goal[]  // 回传 Planner 重新规划
  isComplete: boolean  // 是否已全覆盖
}
```

### 3.4 ApprovalManager (审批流管理)

**审批流全生命周期**:

```typescript
interface ApprovalManager {
  /** 创建审批 */
  createApproval(input: ApprovalInput): Promise<Approval>
  
  /** 响应审批 */
  respondToApproval(approvalId: string, response: 'approve' | 'deny' | 'pending'): Promise<void>
  
  /** 超时处理 */
  handleTimeout(approvalId: string): Promise<void>
  
  /** 恢复审批 */
  recover(approvalId: string): Promise<void>
  
  /** 获取审批状态 */
  getStatus(approvalId: string): ApprovalStatus
}

interface ApprovalInput {
  toolName: string
  toolInput: { [key: string]: unknown }
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  maxTimeoutMs: number  // 默认 300000 (5min)
}

type ApprovalStatus = {
  status: 'pending' | 'waiting' | 'approved' | 'denied' | 'timed_out'
  createdAt: number
  respondedAt?: number
  response?: 'approve' | 'deny' | 'pending'
}
```

### 3.5 Agent Loop 核心（对齐 Claude Code query.ts）

> **对齐 Claude Code `query.ts` (1,729 行)**。Claude Code 的 Agent Loop 是一个 **AsyncGenerator 状态机**，使用 `let state` 在循环间传递可变状态，通过 `continue` 实现递归调用。

**核心状态定义**：

```typescript
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number  // 输出 token 恢复计数 (max 3)
  hasAttemptedReactiveCompact: boolean   // 已尝试响应式压缩
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: { reason: string } | undefined  // 上次 continue 的原因
}
```

**核心循环**：

```typescript
// Agent Loop 核心 — AsyncGenerator 状态机
// 对齐 Claude Code query() 函数
export async function* query(
  params: QueryParams,
): AsyncGenerator<StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage, Terminal> {
  // 1. 初始化不可变参数
  const { systemPrompt, userContext, systemContext, canUseTool, fallbackModel,
          querySource, maxTurns, skipCacheWrite } = params
  const deps = params.deps ?? productionDeps()

  // 2. 初始化可变状态
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
  }
  const budgetTracker = createBudgetTracker()
  let taskBudgetRemaining: number | undefined = undefined

  // 3. 构建查询配置（一次性）
  const config = buildQueryConfig()

  // 4. 启动异步预加载（不阻塞主循环）
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(state.messages, state.toolUseContext)
  const pendingSkillPrefetch = startSkillDiscoveryPrefetch(null, state.messages, state.toolUseContext)

  // 5. 主循环
  while (true) {
    // 5a. 解构当前状态
    let { toolUseContext } = state
    const { messages, autoCompactTracking, maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact, maxOutputTokensOverride,
            pendingToolUseSummary, stopHookActive, turnCount } = state

    // 5b. 构建完整上下文 (Layer 5)
    let messagesForQuery = buildContextForQuery(state, config)

    // 5c. Auto-Compact（压缩前检查）
    let snipTokensFreed = 0
    let compactionResult = await maybeAutoCompact(
      messagesForQuery, toolUseContext, {
        systemPrompt, userContext, systemContext, toolUseContext,
        forkContextMessages: messagesForQuery,
      }, querySource, tracking, snipTokensFreed
    )

    if (compactionResult) {
      for (const msg of postCompactMessages(compactionResult)) { yield msg }
      messagesForQuery = postCompactMessages(compactionResult)
      taskBudgetRemaining = Math.max(0, (taskBudgetRemaining ?? params.taskBudget.total)
        - finalContextTokens(messagesForQuery))
      tracking = { compacted: true, turnId: deps.uuid(), turnCounter: 0, consecutiveFailures: 0 }
    }

    // 5d. 阻塞限制检查
    if (!compactionResult && !isAutoCompactEnabled()) {
      const { isAtBlockingLimit } = calculateTokenWarningState(
        tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
        toolUseContext.options.mainLoopModel
      )
      if (isAtBlockingLimit) {
        yield createAssistantAPIErrorMessage({ content: PROMPT_TOO_LONG_ERROR_MESSAGE })
        return { reason: 'blocking_limit' }
      }
    }

    let attemptWithFallback = true
    const assistantMessages: AssistantMessage[] = []
    const toolResults: (UserMessage | AttachmentMessage)[] = []
    const toolUseBlocks: ToolUseBlock[] = []
    let needsFollowUp = false

    // 5e. API 调用 (Layer 4)
    while (attemptWithFallback) {
      attemptWithFallback = false
      try {
        for await (const message of deps.callModel({
          messages: prependUserContext(messagesForQuery, userContext),
          systemPrompt: fullSystemPrompt,
          thinkingConfig: toolUseContext.options.thinkingConfig,
          tools: toolUseContext.options.tools,
          signal: toolUseContext.abortController.signal,
          options: {
            getToolPermissionContext() { return toolUseContext.getAppState().toolPermissionContext },
            model: currentModel,
            fallbackModel,
            onStreamingFallback: () => { streamingFallbackOccured = true },
          },
        })) {
          if (isToolCall(message)) { toolUseBlocks.push(message.toolUse); needsFollowUp = true }
          if (isStream(message)) { yield message }
        }
      } catch (innerError) {
        // Model fallback: 降级到备用模型
        if (innerError instanceof FallbackTriggeredError && fallbackModel) {
          currentModel = fallbackModel
          attemptWithFallback = true
          streamingToolExecutor?.discard()
          streamingToolExecutor = new StreamingToolExecutor(...)
          messagesForQuery = stripSignatureBlocks(messagesForQuery)
          yield createSystemMessage(`Switched to ${fallbackModel} due to high demand`, 'warning')
          continue
        }
        throw innerError
      }
    }

    // 5f. 执行工具 (Layer 3)
    const toolUpdates = streamingToolExecutor?.getRemainingResults()
      ?? runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
    for await (const update of toolUpdates) {
      if (update.message) {
        yield update.message
        toolResults.push(...normalizeMessagesForAPI([update.message], tools).filter(m => m.type === 'user'))
      }
      if (update.newContext) { toolUseContext = { ...toolUseContext, ...update.newContext } }
    }

    // 5g. 停止钩子 (Layer 6)
    const stopHookResult = yield* handleStopHooks(messagesForQuery, assistantMessages, systemPrompt, userContext, systemContext, toolUseContext, querySource, stopHookActive)
    if (stopHookResult.preventContinuation) return { reason: 'stop_hook_prevented' }
    if (stopHookResult.blockingErrors.length > 0) {
      state = { ...next, transition: { reason: 'stop_hook_blocking' } }
      continue
    }

    // 5h. Token 预算 (Layer 4)
    const budgetDecision = checkTokenBudget(budgetTracker, agentId, turnBudget, outputTokens)
    if (budgetDecision.action === 'continue') {
      state = { ...next, transition: { reason: 'token_budget_continuation' } }
      continue
    }

    // 5i. 完成
    return { reason: 'completed' }
  }
}
```

### 3.6 Auto-Compact 多层压缩系统（对齐 Claude Code 源码）

**五层压缩对齐表**：

| 层级 | 触发条件 | 对齐度 | Phase |
|------|---------|--------|-------|
| **L1 Proactive** | 压缩前检查 (tokenCount > threshold) | ✅ 100% | Phase 1 |
| **L2 Reactive** | API 413 错误 | ✅ 100% | Phase 1 |
| **L3 Snip** | 用户 `/compact` 触发 | ✅ 100% | Phase 1 |
| **L4 Context Collapse** | 实验性 (CONTEXT_COLLAPSE) | ⚠️ Phase 3 | Phase 3 |
| **L5 Micro-Compact** | API cache_deleted | ⚠️ Phase 3 | Phase 3 |

**阈值计算（对齐 Claude Code）**：

```typescript
function getAutoCompactThreshold(model: string): number {
  const contextWindow = getContextWindowForModel(model)  // 200k (sonnet-4-6)
  const reservedTokensForSummary = 20_000               // 摘要预留
  const buffer = 13_000                                  // 安全缓冲
  const maxOutputTokens = getMaxOutputTokens(model)      // 模型特定
  return contextWindow - reservedTokensForSummary - buffer - maxOutputTokens
}
// claude-sonnet-4-6 (200k): 200k - 20k - 13k - 8k = 159k
// claude-opus (400k):       400k - 20k - 13k - 8k = 359k
```

### 3.7 Command 系统（对齐 Claude Code commands.ts）

**12 大分类 113 个命令**：

| 类别 | 数量 | Phase 1 | Phase 2 | Phase 3 |
|------|------|---------|---------|---------|
| 核心/生命周期 | 15 | 15 | - | - |
| 上下文/记忆 | 12 | 8 | 2 | 2 |
| 代码操作 | 15 | - | 8 | 7 |
| 权限/安全 | 6 | 2 | 4 | - |
| MCP/插件 | 8 | 3 | 2 | 3 |
| 配置/UI | 10 | - | 6 | 4 |
| 桥接/远程 | 8 | - | 3 | 5 |
| 调试/诊断 | 12 | - | 4 | 8 |
| 社交 | 5 | - | 1 | 4 |
| Kairos/高级 | 5 | - | - | 5 |
| Voice | 1 | - | - | 1 |
| Skills/初始化 | 2 | 2 | - | - |
| **总计** | **113** | **30** | **30** | **34** |

Phase 1 实现的 30 个核心命令：
```
/exit, /clear, /resume, /help, /version, /cost, /usage, /status,
/compact, /model, /mode, /effort, /fast, /context, /add-dir, /ctx-viz,
/memory, /plan, /session, /diff, /permissions, /sandbox-toggle, /mcp,
/plugin, /providers, /skills, /hooks, /config, /init
```

### 3.8 工具系统（对齐 Claude Code Tool.ts + tools.ts）

**buildTool 工厂模式**：

```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => false,
  checkPermissions: (input) => Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: () => '',
  userFacingName: () => '',
}

function buildTool(def) {
  return { ...TOOL_DEFAULTS, userFacingName: () => def.name, ...def }
}
```

**40+ 内建工具**：AgentTool, BashTool, FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool, WebFetchTool, WebSearchTool, TodoWriteTool, TaskOutputTool, TaskStopTool, AskUserQuestionTool, SkillTool, ExitPlanModeV2Tool, EnterPlanModeTool, EnterWorktreeTool, ExitWorktreeTool, ListMcpResourcesTool, ReadMcpResourceTool, ToolSearchTool...

**CodeClaw 独有工具**：
- **LSPTool** — 代码库符号查询（依赖 multilspy）
- **IntentParser** — 意图解析器
- **Planner** — 目标拆解引擎
- **Reflector** — Gap Analysis 引擎

### 3.9 任务系统（对齐 Claude Code Task.ts）

```typescript
type TaskType = 'local_bash' | 'local_agent' | 'remote_agent' |
                'in_process_teammate' | 'local_workflow' | 'monitor_mcp' | 'dream'

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}
```

### 3.10 权限系统（对齐 Claude Code 权限设计）

**6 种权限模式**：default / plan / auto / acceptEdits / bypassPermissions / dontAsk

**规则来源优先级**：CLI > flagSettings > policySettings > project > user > dynamic

### 3.11 钩子系统（对齐 Claude Code hooks）

**7 种钩子**：pre/post_tool_use, pre/post_compact, session_start, pre/post_stream

### 3.12 技能系统（对齐 Claude Code skills）

**加载**：`.codeclaw/skills/` 目录下的 SKILL.md 文件 + 动态发现

### 3.13 插件系统（对齐 Claude Code plugins）

**3 类插件**：内建 / 用户 / Marketplace，通过 `getPluginCommands()` 注册命令

### 3.14 Intent 系统（CodeClaw 核心差异化）

**意图识别 → 分类 → 路由**：

```typescript
interface IntentSystem {
  /** 解析用户输入 */
  parse(input: string): Promise<Intent>
  
  /** 分类意图 */
  classify(intent: Intent): Promise<Strategy>
  
  /** 路由到对应 Executor */
  route(strategy: Strategy): Promise<Executor>
}

type Intent = {
  type: 'task' | 'query' | 'create' | 'fix' | 'analyze'
  entities: { files: string[], functions: string[], modules: string[] }
  constraints: { timeLimit?: number, budgetLimit?: number, qualityThreshold?: number }
  confidence: number
}

type Strategy =
  | { type: 'dag-planning'; maxDepth: number }
  | { type: 'direct-response'; model: string }
  | { type: 'scaffolding'; pattern: string }
  | { type: 'diagnostic'; focus: string }
  | { type: 'analysis'; scope: string }
```

---

## 四、技术方案

### 4.1 实施总原则

1. 以 CLI-first 为 MVP 主线，Phase 1 不依赖 SDK/HTTP/微信即可独立交付
2. 先做单 Agent 稳定闭环，再做 Planner/Reflector 增强，不跳过可验证基础设施
3. 所有高风险能力必须有降级路径，失败时回退到更简单但可工作的方案
4. 技术实现优先满足“可验证完成”，而不是“概念上完整”

### 4.2 MVP 技术边界

**Phase 1 只承诺以下能力**：

| 能力 | 范围 | 非目标 |
|------|------|--------|
| 主交互渠道 | CLI REPL | 微信、Mobile |
| LLM 能力 | 单轮对话 + 工具调用 + 基础恢复 | 通用多 Agent 协作 |
| 任务编排 | 轻量计划 + 顺序执行 | 通用 DAG 调度平台 |
| 语义能力 | 文件树 + grep + glob + 可选 LSP | 完整跨语言调用图 |
| 记忆系统 | L1 Auto-Compact + L2 Session 持久化 | 高质量通用 RAG 问答 |
| 审批流 | 单会话内审批、重启后恢复 | 跨渠道审批迁移 |

### 4.3 10 个技术缺口与补齐策略

| # | 技术缺口 | 实现补齐策略 | 落地要求 |
|---|----------|--------------|----------|
| 1 | 规划结果不可验证 | Goal 必须包含 `completionChecks[]`，Executor 负责执行检查 | 无检查项的 Goal 不允许进入执行态 |
| 2 | Reflector 自评自证 | Reflector 只能读取工具结果、测试结果、文件 diff、显式检查结果 | Assistant 文本不能单独作为完成依据 |
| 3 | LSP 不稳定 | `LSPTool` 失败时回退到 `Glob + Grep + BM25` | 不因语言服务器异常阻塞主流程 |
| 4 | RAG 结果不可解释 | 每条检索结果必须返回来源文件、chunk 偏移、召回原因 | UI/日志中可追踪每次召回 |
| 5 | 审批无法恢复 | 审批状态持久化到 SessionStore，启动时自动扫描未决审批 | 重启后可继续 approve / deny / cancel |
| 6 | 工具副作用不可控 | 为工具定义 `riskLevel`、`sideEffectType`、`rollbackHint` | 高风险操作必须进入 ask/plan 流程 |
| 7 | Token 预算漂移 | 为 query、compact、tool output 分别记录预算 | 任一预算超限时触发降级或停止 |
| 8 | 会话状态过重 | L1、L2、审批、命令态分离存储，避免单对象膨胀 | SessionState 可序列化且支持增量更新 |
| 9 | 回归不可复现 | 建立 transcript 回放和 deterministic tool stub | 核心流程必须可回放测试 |
| 10 | 渠道抽象过早 | Phase 1 只固化 Ingress/Delivery 接口，不做所有渠道特性下沉 | CLI 之外的渠道以适配器方式后置 |

### 4.4 编排闭环的完成判定

```typescript
type GoalDefinition = {
  id: string
  description: string
  completionChecks: CompletionCheck[]
  allowedTools: string[]
  fallbackStrategy?: 'retry' | 'replan' | 'escalate'
}

type CompletionCheck =
  | { type: 'file_exists'; path: string }
  | { type: 'text_contains'; path: string; pattern: string }
  | { type: 'command_exit_code'; command: string; exitCode: number }
  | { type: 'test_passed'; command: string }
  | { type: 'diff_expected'; path: string }
```

**约束**：

1. Planner 产出的每个 Goal 必须附带至少一个 `completionCheck`
2. Executor 只在检查通过后才能把 Goal 标为 completed
3. Reflector 只对 failed / missing / partial checks 做 gap 分析
4. 连续两轮生成相同 Goal 且 checks 仍失败时，直接进入 `ESCALATED`

### 4.5 LSP 与检索的降级策略

```
优先级 1: LSP 符号查询可用
  → 用 symbol / definition / references / hover 补强定位

优先级 2: BM25 + 文件树
  → 用 Glob/Grep/关键词召回替代 LSP

优先级 3: 纯文件启发式
  → 仅依赖目录、文件名、import 文本模式
```

**降级原则**：

1. 不因单个能力失败而终止整轮任务
2. 降级要写入 trace，便于后续定位质量下降原因
3. 只有当核心工具都不可用时才请求用户介入

### 4.6 索引与持久化策略

| 模块 | Phase 1 实现 | 后续增强 |
|------|--------------|----------|
| Session 持久化 | JSONL append-only | SQLite 镜像索引 |
| 审批状态 | JSONL + 内存缓存 | SQLite 事务表 |
| RAG 索引 | BM25 文件级索引 | chunk 级向量索引 |
| LSP 缓存 | 进程内缓存 | 磁盘快照 + 增量更新 |

### 4.7 Phase 级验收口径

**Phase 1**

1. 20 条 transcript 回放通过
2. 5 类工具权限路径全部覆盖
3. 3 个 Provider 可切换，失败时可回退
4. 上下文过长能压缩并继续对话

**Phase 2**

1. Planner / Executor / Reflector 至少覆盖 10 个真实任务样例
2. SDK/HTTP API 复用同一 Session 语义和权限模型
3. LSP 失败回退路径可验证

**Phase 3**

1. 微信渠道复用同一审批状态机
2. RAG 与增强 LSP 对真实任务成功率有提升数据
3. 多 Agent 默认关闭，仅在特定工作流启用

---

## 五、技术标准与规范

### 5.1 接口与模块边界

1. `DESIGN.md` 中的名词必须映射到明确代码模块，不允许同名多义
2. `Provider`、`Tool`、`Command`、`ChannelAdapter`、`SessionStore` 必须各自独立
3. 任何跨层访问都要经过显式接口，不允许 UI 直接操作 Provider 或持久层

### 5.2 状态机约束

**Agent Loop 状态转移**：

```
IDLE
  → PLANNING
  → EXECUTING
  → REFLECTING
  → COMPLETED | RETRYING | REPLANNING | HALTED | ESCALATED
```

**硬约束**：

1. 任何状态转移都必须记录 `traceId`
2. `ESCALATED` 和 `HALTED` 为终止态，不得隐式继续
3. `RETRYING` 必须带失败原因和重试次数
4. 连续失败达到上限后只能进入 `REPLANNING` 或 `ESCALATED`

### 5.3 工具规范

| 规范 | 要求 |
|------|------|
| 输入验证 | 所有工具必须先做 schema 校验 |
| 权限检查 | 所有副作用工具必须实现 `checkPermissions()` |
| 可观测性 | 每次工具调用写入 tool name、input 摘要、耗时、结果 |
| 并发性 | 未显式声明 `isConcurrencySafe()` 的工具默认串行 |
| 结果格式 | 工具输出必须结构化，可转回模型上下文 |

### 5.4 检索与上下文标准

1. RAG 返回结果必须包含来源路径和截断标记
2. Compact 摘要必须保留用户目标、关键文件、未完成事项、审批状态
3. 模型上下文中不得重复注入同一批检索结果
4. 文件内容注入优先使用片段，不默认注入整文件

### 5.5 测试标准

| 测试类型 | Phase 1 最低要求 |
|----------|------------------|
| 单元测试 | Provider、Permission、ToolRegistry、Compact 至少覆盖核心分支 |
| 回放测试 | 20 条 transcript golden tests |
| 集成测试 | CLI 发消息 → 工具调用 → 输出回传 全链路通过 |
| 恢复测试 | 进程中断后会话与审批状态可恢复 |
| 负载测试 | 长对话压缩、超长工具输出、Provider 超时三类场景 |

### 5.6 可观测性标准

1. 日志采用结构化 JSON，字段至少包括 `traceId`、`sessionId`、`phase`、`provider`、`tool`
2. 所有异常必须有错误码或错误类别，不允许只输出自由文本
3. 成本统计按 provider、session、turn 三层聚合
4. 压缩、回退、降级行为必须可查询

### 5.7 文档标准

1. 功能文档描述“做什么”和“分期”
2. 技术文档描述“怎么做”和“怎么验收”
3. 开发任务文档描述“谁做什么”
4. 三者术语必须一致，更新任一文档时需同步检查其余两者

---

## 六、部署与运维

### 6.1 运行环境

| 环境 | 要求 |
|------|------|
| Node.js | 22 LTS |
| 包管理 | npm 10+ |
| Bun | 1.x（build-only） |
| 本地目录 | `~/.codeclaw/` |
| 可选依赖 | Ollama / LMStudio / LSP 服务器 |

### 6.2 目录约定

```
~/.codeclaw/
├── config.yaml
├── providers.json
├── sessions/
├── approvals/
├── logs/
├── cache/
│   ├── rag/
│   └── lsp/
└── plugins/
```

### 6.3 启动与恢复流程

1. 读取 `config.yaml` 与 `providers.json`
2. 初始化 ProviderRegistry、ToolRegistry、CommandRegistry
3. 扫描 `sessions/` 和 `approvals/`，恢复未终结状态
4. 对 CLI 输出当前可恢复会话和未决审批摘要
5. 延迟加载 RAG/LSP，避免阻塞首轮交互

### 6.3.1 首次启动与 Setup 向导

**首次启动判定**：

```typescript
type BootstrapMode =
  | 'first_run'
  | 'normal_start'
  | 'recovery_start'
  | 'restricted_start'
```

**判定逻辑**：

1. `config.yaml` 不存在或为空 → `first_run`
2. 存在未终结 session / approval → `recovery_start`
3. 配置存在但无可用 Provider → `restricted_start`
4. 其余情况 → `normal_start`

**Setup 向导步骤**：

| 步骤 | 输入 | 输出 |
|------|------|------|
| Welcome | 语言选择 | `language` |
| Provider Select | Anthropic / OpenAI / Ollama / LMStudio | `defaultProvider` |
| Credential Check | API Key / Base URL / 本地模型 | provider config |
| Workspace Select | 默认工作目录 | `defaultWorkspace` |
| Permission Select | default / plan / auto / acceptEdits | `permissionMode` |
| Summary Confirm | 配置预览 | 写入 `config.yaml` |

**降级路径**：

1. 云 Provider 校验失败但本地模型可用 → 切换本地 Provider 继续
2. 无可用 Provider → 进入 restricted mode，仅开放 `/help`、`/config`、`/doctor`
3. 用户跳过 setup → 写入最小配置并提示稍后补全

### 6.3.2 启动状态机

```text
BOOTING
  → CHECK_CONFIG
  → SELECT_MODE
  → RUN_SETUP | LOAD_RUNTIME | LOAD_RECOVERY | ENTER_RESTRICTED
  → READY
```

**状态说明**：

| 状态 | 说明 |
|------|------|
| `BOOTING` | 进程启动、准备依赖 |
| `CHECK_CONFIG` | 检查配置、Provider、目录 |
| `RUN_SETUP` | 首次启动向导 |
| `LOAD_RUNTIME` | 初始化核心运行时 |
| `LOAD_RECOVERY` | 恢复 session / approval |
| `ENTER_RESTRICTED` | 无法正常运行时进入受限模式 |
| `READY` | 允许进入 REPL |

### 6.3.3 恢复策略

**恢复优先级**：

1. 未决审批
2. 用户明确中断的会话
3. 最近一次未完成任务
4. 普通历史会话

**CLI 恢复提示示例**：

```text
Recovered 1 pending approval and 2 resumable sessions.
[1] Resume approval: edit src/config.ts
[2] Resume session: "fix failing tests"
[3] Start a new session
```

### 6.3.4 冷启动性能目标

| 指标 | 目标 |
|------|------|
| 无网络冷启动 | < 500ms |
| 有配置正常启动 | < 1.5s |
| 首次 setup 可交互时间 | < 2s |
| 恢复态首屏展示 | < 2s |

### 6.3.5 CLI TUI 架构

**P1 组件树**：

```text
<AppShell>
  <Header />
  <TranscriptPane />
  <StatusBar />
  <ApprovalPanel />
  <Composer />
  <FooterHints />
</AppShell>
```

**组件职责**：

| 组件 | 职责 |
|------|------|
| `Header` | 显示 sessionId、model、permissionMode、cwd、budget |
| `TranscriptPane` | 展示用户消息、助手消息、工具摘要、系统提示 |
| `StatusBar` | 展示当前 agent phase 和次要状态 |
| `ApprovalPanel` | 展示审批详情和 approve/deny 快捷键 |
| `Composer` | 输入框、命令补全、快捷提示 |
| `FooterHints` | `/help`、`/resume`、`Ctrl+C`、`Esc` 等操作提示 |

**实现视图线框**：

```text
┌─ AppShell ───────────────────────────────────────────────────────────────────┐
│ ┌─ Header ────────────────────────────────────────────────────────────────┐ │
│ │ session/model/provider/mode/cwd/budget                                 │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ TranscriptPane ────────────────────────────────────────────────────────┐ │
│ │ MessageBlock(user)                                                      │ │
│ │ MessageBlock(assistant)                                                 │ │
│ │ ToolResultBlock(bash/read/edit)                                         │ │
│ │ StreamingBlock                                                          │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ StatusBar ─────────────────────────────────────────────────────────────┐ │
│ │ uiPhase / current task / compact status / warnings                      │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ ApprovalPanel (conditional) ───────────────────────────────────────────┐ │
│ │ tool / risk / summary / key actions                                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ Composer ──────────────────────────────────────────────────────────────┐ │
│ │ input value / command suggestions / cursor state                        │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ FooterHints ───────────────────────────────────────────────────────────┐ │
│ │ Enter / Tab / Ctrl+C / Esc / arrows                                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

**渲染原则**：

1. TranscriptPane 占用绝大多数高度，避免状态区挤压主输出
2. ApprovalPanel 仅在 `waiting_approval` 时显示
3. StatusBar 保持单行，超长信息截断并写入 tooltip/banner
4. 窄终端下 Header 和 FooterHints 自动压缩字段

### 6.3.6 交互状态模型

```typescript
type UiPhase =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'waiting_approval'
  | 'compacting'
  | 'recovering'
  | 'completed'
  | 'errored'

type UiBanner =
  | { type: 'info'; text: string }
  | { type: 'warning'; text: string }
  | { type: 'error'; text: string }
  | { type: 'success'; text: string }
```

**状态映射规则**：

1. Agent Loop 进入 planning → `UiPhase = planning`
2. 工具执行中 → `UiPhase = executing`
3. 审批挂起 → `UiPhase = waiting_approval`
4. 触发 compact → `UiPhase = compacting`
5. 启动恢复流程 → `UiPhase = recovering`
6. 任务成功结束 → `UiPhase = completed`
7. 未恢复错误 → `UiPhase = errored`

### 6.3.7 关键交互事件流

**任务执行事件流**：

```text
UserSubmit
  → SessionAppend(user message)
  → AgentLoopStart
  → UiPhase(planning)
  → ToolRunStart/End
  → UiPhase(executing)
  → AssistantStream
  → UiPhase(completed)
```

**审批事件流**：

```text
PermissionAsk
  → ApprovalCreated
  → UiPhase(waiting_approval)
  → UserApprove | UserDeny
  → ApprovalResolved
  → AgentLoopResume | AgentLoopAbort
```

**恢复事件流**：

```text
ProcessRestart
  → ScanSessionsAndApprovals
  → RecoverySummaryRendered
  → UserSelectResume
  → RestoreContext
  → UiPhase(recovering)
  → AgentLoopResume
```

### 6.3.8 CLI 快捷操作约定

| 操作 | 行为 |
|------|------|
| `Enter` | 发送消息 |
| `Ctrl+C` | 中断当前执行，不退出整个程序 |
| `Esc` | 关闭当前浮层/审批卡片焦点 |
| `Tab` | 命令补全 |
| `↑` / `↓` | 输入历史 |
| `a` / `d` | 审批场景下 approve / deny |

### 6.3.9 界面降级策略

1. Ink 渲染失败时，自动降级为纯文本 REPL
2. 终端不支持复杂重绘时，关闭动态 spinner，仅保留状态行
3. 窄终端宽度下隐藏次级信息，只保留 Header 核心字段
4. 非交互终端中禁用审批卡片，改用文本确认提示

### 6.4 日志与排障

**日志文件**：

| 文件 | 内容 |
|------|------|
| `logs/app.log` | 主进程日志 |
| `logs/provider.log` | Provider 请求与失败摘要 |
| `logs/tool.log` | 工具调用与权限决策 |
| `logs/compact.log` | 压缩、降级、预算行为 |

**排障命令**：

```bash
codeclaw doctor
codeclaw sessions list
codeclaw approvals list
codeclaw debug trace <traceId>
```

### 6.5 数据安全与恢复

1. Session JSONL 采用 append-only，避免部分写入破坏整文件
2. 审批状态变更必须先写盘再更新内存
3. SQLite 引入后只作为索引与查询加速层，原始事件日志仍保留
4. 删除类操作默认保留 tombstone 记录，便于审计

### 6.6 版本升级策略

1. 升级前先备份 `config.yaml`、`sessions/`、`approvals/`
2. 配置升级使用显式 migration version
3. 新版本首次启动先跑 migration，再开放用户交互
4. 若 migration 失败，回退到只读恢复模式

### 6.7 渠道部署策略

| 渠道 | 部署策略 |
|------|----------|
| CLI | 与主进程同包发布 |
| SDK/HTTP | 以单独 gateway mode 启动，复用 Core Engine |
| 微信 | 独立 channel adapter 进程，避免拖垮 CLI 主进程 |

### 6.8 P1 启动与界面验收

1. 在空配置机器上运行 `codeclaw` 可进入 setup 并完成首次配置
2. 在存在未决审批时启动，CLI 首屏会展示恢复入口
3. `Ctrl+C` 可中断当前任务而不导致状态丢失
4. 终端宽度变化不会导致核心状态信息完全消失
5. 无 Ink 环境下可降级为纯文本模式继续使用

---

## 七、里程碑与迭代计划

### Phase 1: 核心闭环 (W1-W4) — 12 个任务

| 任务 | 描述 | 依赖 |
|------|------|------|
| T1.1 | Provider 抽象层 (4 模型) | 无 |
| T1.2 | Agent Loop（对齐 query.ts） | T1.1 |
| T1.3 | L1 Proactive Auto-Compact | T1.2 |
| T1.4 | L2 Reactive Compact (413) | T1.2 |
| T1.5 | L3 Snip Compact | T1.2 |
| T1.6 | File Tools (Read/Write/Edit/Glob) | 无 |
| T1.7 | Shell Tool (Bash) | T1.6 |
| T1.8 | Core Commands (15 个) | T1.2 |
| T1.9 | Context Commands (8 个) | T1.2 |
| T1.10 | Permission System | T1.6 |
| T1.11 | CLI REPL | T1.2 |
| T1.12 | Ingress Gateway | T1.9 |

### Phase 2: 智能编排 (W5-W7) — 8 个任务

| 任务 | 描述 | 依赖 |
|------|------|------|
| T2.1 | Codebase Graph + Symbol Index | T1.7 |
| T2.2 | Planner (IntentParser + GoalPlanner) | T2.1 |
| T2.3 | Executor (DAG 调度) | T2.2 |
| T2.4 | Reflector (Gap Analysis) | T2.3 |
| T2.5 | SDK/HTTP API | T1.12 |
| T2.6 | MCP 集成 | 无 |
| T2.7 | Remaining Commands (35 个) | T1.8 |
| T2.8 | Skill System | T1.9 |

### Phase 3: 高级能力 (W8-W10) — 6 个任务

| 任务 | 描述 | 依赖 |
|------|------|------|
| T3.1 | Agent Team | T2.6 |
| T3.2 | LSP 深度 | T1.5 |
| T3.3 | L4 Context Collapse | T1.4 |
| T3.4 | L5 Micro-Compact | T1.4 |
| T3.5 | 微信 Bot | T1.10 |
| T3.6 | 插件系统 | T2.8 |

### Phase 4: 打磨优化 (W11-W12) — 3 个任务

| 任务 | 描述 |
|------|------|
| T4.1 | 性能优化 |
| T4.2 | 错误处理 |
| T4.3 | 测试覆盖 |

---

## 八、风险评估与应对

### 风险矩阵

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| Agent Loop 状态机复杂度高 | 中 | 高 | Phase 1 只实现核心路径，后续迭代增强 |
| Auto-Compact 压缩摘要质量 | 中 | 中 | 压缩 prompt 多轮迭代优化 + 指标监控 |
| Command 系统规模超出预期 | 高 | 中 | Phase 1 只做 30 个核心命令，分阶段实现 |
| Provider 兼容性问题 | 低 | 高 | Provider 抽象层 + 各 Provider 独立测试 |
| Token 估算不准导致溢出 | 中 | 高 | tokenCountWithEstimation + buffer + 压缩安全网 |
| 多渠道消息路由复杂 | 中 | 中 | MVP 先做 CLI/SDK，Phase 3 加微信 |
| Planner 意图识别准确率 | 中 | 高 | IntentParser 多轮迭代 + 用户反馈闭环 |
| 三层记忆系统性能 | 中 | 中 | L3 RAG 增量更新 + 索引范围限制 |

---

## 附录 A: 与 Claude Code 深度对照

### Agent Loop（query.ts）对照

| 特性 | Claude Code 实现 | CodeClaw 对齐度 |
|------|-----------------|---------------|
| 循环模式 | `while(true)` + `state = next` + `continue` | ✅ 100% |
| StreamingToolExecutor | 并行流式工具执行 | ✅ 100% |
| Model Fallback | FallbackTriggeredError → stripSignatureBlocks → retry | ✅ 100% |
| Max Output Recovery | 最多 3 次 + recoveryMessage | ✅ 100% |
| Auto-Compact | 压缩前检查 + LLM 摘要 | ✅ 100% |
| Reactive Compact | API 413 触发 | ✅ 100% |
| Token Budget | checkTokenBudget + taskBudget 跨 compact | ✅ 100% |
| State Tracking | transition.reason 枚举 | ✅ 100% |
| Command Injection | getCommandsByMaxPriority() | ✅ 100% |
| Memory Prefetch | async prefetch + consume | ✅ 100% |
| Skill Discovery | async prefetch + collect | ✅ 100% |
| Streaming Fallback | discard + recreate executor | ✅ 100% |

### Auto-Compact 对照

| 特性 | Claude Code | CodeClaw | 对齐度 |
|------|------------|----------|--------|
| L1 Proactive | autoCompact.ts | autoCompact.ts | ✅ 100% |
| L2 Reactive | reactiveCompact.ts | reactiveCompact.ts | ✅ 100% |
| L3 Snip | snipCompact.ts | snipCompact.ts | ✅ 100% |
| L4 Collapse | contextCollapse/ | contextCollapse.ts | ⚠️ Phase 3 |
| L5 Micro | microCompact.ts | microCompact.ts | ⚠️ Phase 3 |
| 阈值计算 | 每模型独立 | 每模型独立 | ✅ 100% |
| 压缩摘要 | LLM 生成 | LLM 生成 | ✅ 100% |
| 指标记录 | 10+ 项 | 10+ 项 | ✅ 100% |

### Command 系统对照

| 特性 | Claude Code | CodeClaw | 对齐度 |
|------|------------|----------|--------|
| Command 总数 | 113 | Phase 1: 30, Phase 2: 35, Phase 3: 55 | ⚠️ 渐进实现 |
| 命令类型 | prompt/local/streaming/task-notification | 相同 | ✅ 100% |
| 注册机制 | getCommands() 单一来源 | getCommands() 单一来源 | ✅ 100% |
| 多源发现 | builtin + skill + plugin + dynamic | 相同 | ✅ 100% |
| 优先级注入 | getCommandsByMaxPriority() | 相同 | ✅ 100% |
| 命令目录组织 | src/commands/ (113 目录) | 相同结构 | ✅ 100% |

### Task 系统对照

| 特性 | Claude Code | CodeClaw | 对齐度 |
|------|------------|----------|--------|
| 任务类型 | 7 种 | 7 种 | ✅ 100% |
| Task ID 生成 | 前缀 + 8 位随机 | 相同 | ✅ 100% |
| 状态机 | pending → running → completed/failed/killed | 相同 | ✅ 100% |
| TaskStateBase | id/type/status/description/toolUseId/startTime/endTime/outputFile/outputOffset | 相同 | ✅ 100% |

### 权限系统对照

| 特性 | Claude Code | CodeClaw | 对齐度 |
|------|------------|----------|--------|
| 权限模式 | 6 种 | 6 种 | ✅ 100% |
| 权限矩阵 | allow/ask/deny per 操作 | 相同 | ✅ 100% |
| 规则来源优先级 | cliArg > flagSettings > policySettings > project > user > dynamic | 相同 | ✅ 100% |
| checkPermissions | tool-specific | 相同 | ✅ 100% |

### Token Budget 对照

| 特性 | Claude Code | CodeClaw | 对齐度 |
|------|------------|----------|--------|
| Token Budget | createBudgetTracker + checkTokenBudget | 相同 | ✅ 100% |
| Task Budget | API task_budget (跨 compact) | 相同 | ✅ 100% |
| 阈值计算 | getCurrentTurnTokenBudget() | 相同 | ✅ 100% |
| 决策输出 | { action: 'continue'/'warn'/'stop' } | 相同 | ✅ 100% |

---

## 附录 B: Auto-Compact 对比论证

### B.1 为什么需要多层压缩？

**旧版单一阈值的问题**：
- 只处理 "上下文 > 阈值" 这一种情况
- 无法应对 API 413 错误
- 无法应对输出 tokens 超限
- 无法处理媒体内容过大
- 没有用户手动压缩能力

**Claude Code 多层压缩的优势**：
1. **Proactive**（压缩前）— 在 API 调用前预防溢出
2. **Reactive**（413 后）— 作为安全网自动恢复
3. **Snip**（用户触发）— 用户主动控制上下文大小
4. **Context Collapse**（实验）— 不丢失信息的紧凑表示
5. **Micro-Compact**（实验）— 基于 API cache 删除的同步

### B.2 阈值计算的精确性

| 模型 | Context Window | Claude Code 阈值 | CodeClaw 阈值 | 差异 |
|------|---------------|-----------------|--------------|------|
| claude-sonnet-4-6 | 200k | 159k | 159k | ✅ 一致 |
| claude-haiku | 32k | 极低 | 极低 | ✅ 一致 |
| claude-opus | 400k | 359k | 359k | ✅ 一致 |

**计算逻辑**：`threshold = contextWindow - reservedForSummary(20k) - buffer(13k) - maxOutputTokens`

### B.3 压缩后指标的可观测性

| 指标 | 说明 |
|------|------|
| originalMessageCount | 压缩前的消息数量 |
| compactedMessageCount | 压缩后的消息数量 |
| preCompactTokenCount | 压缩前的 token 数 |
| postCompactTokenCount | 压缩后的 token 数 |
| truePostCompactTokenCount | 包含附件的压缩后 token 数 |
| compactionInputTokens | 摘要生成的输入 token |
| compactionOutputTokens | 摘要生成的输出 token |
| compactionCacheReadTokens | 摘要生成的 cache read tokens |
| compactionCacheCreationTokens | 摘要生成的 cache creation tokens |
| compactionTotalTokens | 摘要的总 token |
| queryChainId | 查询链 ID |
| queryDepth | 查询深度 |

---

## 附录 C: Command 系统对照清单

### Phase 1 实现的 30 个核心命令：

```
/exit, /clear, /resume, /help, /version, /cost, /usage, /status,
/compact, /model, /mode, /effort, /fast, /context, /add-dir, /ctx-viz,
/memory, /plan, /session, /diff, /permissions, /sandbox-toggle, /mcp,
/plugin, /providers, /skills, /hooks, /config, /init
```

### Phase 2 新增的 35 个命令：

```
/ultraplan, /commit, /commit-push-pr, /branch, /issue, /pr-comments,
/review, /autofix-pr, /code-review, /bug-hunter, /security-review,
/insights, /doctor, /rewind, /share, /export, /summary, /pass,
/privacy-settings, /rate-limit-options, /reset-limits, /reload-plugins,
/agents, /theme, /color, /output-style, /terminal-setup, /debug-tool-call,
/teleport, /remote-env, /remote-setup, /desktop, /mobile, /infra,
/install-github-app
```

### Phase 3 新增的 55 个命令：

```
/good-claude, /stickers, /btw, /buddy, /assistant, /brief, /proactive,
/subscribe-pr, /workflows, /voice, /keybindings, /statusline, /ide,
/bridge, /chrome, /perf-issue, /ant-trace, /heapdump, /mock-limits,
/backfill-sessions, /feedback, /install-slack-app
```

---

## 附录 D: 数据模型详细定义

### D.1 Provider 配置

```typescript
type ProviderConfig = {
  type: 'anthropic' | 'openai' | 'ollama' | 'lmstudio'
  apiKey?: string
  baseUrl?: string
  model?: string
  timeout?: number
  maxRetries?: number
  [key: string]: unknown
}
```

### D.2 Provider 接口

```typescript
interface Provider {
  name: string
  config: ProviderConfig

  sendMessage(
    messages: Message[],
    tools?: Tool[],
    options?: ProviderOptions
  ): AsyncGenerator<ProviderStreamEvent>

  getModels(): Promise<ModelInfo[]>
  getLimits(): ProviderLimits
}

interface ProviderOptions {
  temperature?: number
  maxTokens?: number
  thinkingConfig?: ThinkingConfig
  stopSequences?: string[]
  toolChoice?: ToolChoice
}

interface ProviderStreamEvent {
  type: 'message_start' | 'text_delta' | 'tool_call_delta' | 'stream_end' | 'error'
  delta?: string
  toolCall?: ToolCall
  usage?: APIUsage
}
```

### D.3 Tool 接口

```typescript
interface Tool {
  name: string
  description: string
  inputSchema: ToolInputJSONSchema
  isEnabled(): boolean
  isConcurrencySafe(): boolean
  isReadOnly(): boolean
  isDestructive(): boolean
  checkPermissions(input: { [key: string]: unknown }): Promise<PermissionResult>
  toAutoClassifierInput(input: { [key: string]: unknown }): string
  userFacingName(): string
  run(input: { [key: string]: unknown }): Promise<ToolResult>
}
```

### D.4 SessionState

```typescript
type SessionState = {
  sessionId: string
  channel: 'cli' | 'sdk' | 'wechat' | 'mcp' | 'http'
  userId: string
  model: string
  mainLoopModel: string
  mode: PermissionMode
  permissionMode: PermissionMode
  startTime: number
  lastActivity: number
  fastMode: boolean
  effortValue: number
  advisorModel?: string
  toolPermissionContext: ToolPermissionContext
}
```

### D.5 CompactMetadata

```typescript
type CompactMetadata = {
  preCompactTokenCount: number
  postCompactTokenCount: number
  truePostCompactTokenCount: number
  compactionUsage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  originalMessageCount: number
  compactedMessageCount: number
  queryChainId: string
  queryDepth: number
}
```

---

## 附录 E: API 契约参考

### E.1 IngressGateway 接口

```typescript
interface IngressGateway {
  sendMessage(sessionId: string, input: IngressMessage): AsyncGenerator<SDKMessage>
  getSessionState(sessionId: string): Promise<SessionState>
  interruptSession(sessionId: string): void
  resumeSession(sessionId: string): AsyncGenerator<SDKMessage>
  destroySession(sessionId: string): Promise<void>
  getActiveSessions(): SessionInfo[]
}
```

### E.2 QueryEngine 接口

```typescript
interface QueryEngine {
  submitMessage(prompt: string | ContentBlockParam[]): AsyncGenerator<SDKMessage>
  interrupt(): void
  getMessages(): Message[]
  getSessionId(): string
  setModel(model: string): void
  getReadFileState(): FileStateCache
}
```

### E.3 Command 接口

```typescript
interface Command {
  type: 'prompt' | 'local' | 'streaming' | 'task-notification'
  name: string
  description: string
  contentLength: number
  progressMessage?: string
  source: 'builtin' | 'plugin' | 'skill'

  getPromptForCommand?(args: string[], context: CommandContext): Promise<string>
  run?(args: string[], context: CommandContext): Promise<void>
  stream?(args: string[], context: CommandContext): AsyncGenerator<StreamEvent>

  aliases?: string[]
  hidden?: boolean
  requiresAuth?: boolean
  agentId?: string
}
```

---

> **文档维护**: 本文档随架构演进持续更新。重大变更需通过 ADR 流程审批。  
> **最后更新**: 2026-04-21 | v0.5-cc-aligned (六层架构版)
