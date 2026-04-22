# CodeClaw ver 0.5 开发任务文档

> **版本**: v0.5  
> **日期**: 2026-04-21  
> **关联文档**: `DESIGN.md`、`VER_0.5_TECH_DESIGN.md`  
> **定位**: 将功能设计与技术设计拆解为可执行、可验收、可排期的开发任务

---

## 1. 任务文档使用规则

1. `DESIGN.md` 负责定义“做什么”和“分期”
2. `VER_0.5_TECH_DESIGN.md` 负责定义“怎么做”和“怎么验收”
3. 本文档负责定义“先做什么、产出什么、怎么收尾”
4. 任务完成后，若影响设计边界，必须同步更新前两份文档

---

## 2. 交付目标

v0.5 的目标不是一次性做成完整平台，而是分阶段交付一个可持续扩展的 CLI-first 个人智能体内核。

**v0.5 成功标准**：

1. Phase 1 可独立交付一个稳定可用的 CLI Agent
2. Phase 2 引入可验证的智能编排，而不是概念性 Planner
3. Phase 3 扩展多渠道和高级能力，但不破坏核心闭环
4. Phase 4 补齐测试、性能、可观测性，达到长期维护条件

---

## 3. 总览排期

| Phase | 周期 | 目标 | 交付结果 |
|------|------|------|----------|
| Phase 1 | W1-W4 | 核心闭环 | CLI + Provider + Tool + Compact + Permission + Session |
| Phase 1.5 | W4-W5 | 基础 LSP | 可降级的 LSPTool 与符号查询 |
| Phase 1.9 | W5 | 持久化增强 | SQLite 镜像索引与恢复增强 |
| Phase 2 | W5-W7 | 智能编排 | Planner + Executor + Reflector + SDK/HTTP |
| Phase 3 | W8-W10 | 高级能力 | 微信、插件、RAG、多 Agent 增强 |
| Phase 4 | W11-W12 | 打磨优化 | 测试覆盖、性能优化、错误治理 |

---

## 4. Phase 1: 核心闭环

### T1.0 工程脚手架与编译链

**目标**：建立统一开发环境、标准脚本和正式打包链路。

**关键输出**：

1. `package.json` 标准 scripts
2. TypeScript 基础配置
3. `npm run dev / typecheck / test`
4. `bun run build` 正式打包脚本
5. 基础目录结构与源码入口

**依赖**：无

**验收**：

1. 新机器按文档安装 Node.js、npm、Bun 后可启动开发环境
2. `npm run dev` 可启动源码入口
3. `npm run typecheck`、`npm run test`、`bun run build` 全部可执行
4. `node dist/cli.js --version` 可验证构建产物

### T1.0.1 开发环境文档

**目标**：把开发链路写成新成员可直接照做的文档。

**关键输出**：

1. 环境基线说明
2. 安装步骤
3. 常用命令说明
4. 构建与发布前检查

**依赖**：T1.0

**验收**：

1. 不看源码也能按文档完成环境初始化
2. 文档与实际脚本一致

### T1.1 Provider 抽象层

**目标**：统一 Anthropic / OpenAI / Ollama / LMStudio 的调用接口。

**关键输出**：

1. `Provider` 接口与 `ProviderRegistry`
2. 3 个以上可运行 Provider 适配器
3. 模型切换、fallback、health check
4. usage / cost 结构化记录

**依赖**：无

**验收**：

1. CLI 可通过配置切换 Provider
2. 至少 1 个云 Provider 和 1 个本地 Provider 正常工作
3. Provider 错误会输出统一错误类型

### T1.2 Agent Loop 核心

**目标**：建立单 Agent 主循环，支持消息、流式输出、工具调用和恢复。

**关键输出**：

1. `QueryEngine`
2. 主状态机 `IDLE → PLANNING/EXECUTING → COMPLETED/HALTED`
3. 模型流式输出处理
4. 基础工具调用链路

**依赖**：T1.1

**验收**：

1. 用户可在 CLI 中输入消息并收到流式输出
2. 工具调用结果能回注到上下文
3. 中断后不会破坏会话状态

### T1.3 L1 Proactive Auto-Compact

**目标**：在超长上下文前主动压缩，保证主循环可持续。

**关键输出**：

1. token 估算
2. proactive compact 触发器
3. compact summary 结构
4. compact 指标记录

**依赖**：T1.2

**验收**：

1. 长对话达到阈值后自动 compact
2. compact 后原任务可继续执行
3. compact 前后 token 指标可查询

### T1.4 L2 Reactive Compact

**目标**：在 Provider 报上下文超限或同类错误时自动恢复。

**关键输出**：

1. 413 / context-too-long 错误识别
2. reactive compact 恢复逻辑
3. 降级日志与提示

**依赖**：T1.2

**验收**：

1. 模拟超限错误时系统会自动压缩重试
2. 连续失败达到阈值后会终止并解释

### T1.5 L3 Snip Compact

**目标**：支持手动上下文清理和边界控制。

**关键输出**：

1. `/compact` 命令
2. snip boundary 标记
3. 紧急人工 compact 流程

**依赖**：T1.2

**验收**：

1. 用户可主动 compact 当前上下文
2. compact 后摘要中保留目标、关键文件、未完成事项

### T1.6 File Tools

**目标**：完成核心文件工具能力。

**关键输出**：

1. `FileReadTool`
2. `FileWriteTool`
3. `FileEditTool`
4. `GlobTool`

**依赖**：无

**验收**：

1. 可读写、编辑、搜索文件
2. 输入校验和错误处理完整
3. 编辑类操作接入权限系统

### T1.7 Shell Tool

**目标**：提供受控 Bash 执行能力。

**关键输出**：

1. `BashTool`
2. 安全命令与危险命令分类
3. 执行超时与输出截断
4. 退出码和耗时记录

**依赖**：T1.6

**验收**：

1. 可执行基础 shell 命令
2. 高风险命令会触发审批
3. 超长输出不会拖垮主界面

### T1.8 Core Commands

**目标**：实现最小可用命令系统。

**关键输出**：

1. `/help`
2. `/exit`
3. `/resume`
4. `/model`
5. `/mode`
6. `/status`
7. `/compact`
8. `/config`

**依赖**：T1.2

**验收**：

1. 命令可发现、可执行、可反馈结果
2. 错误命令有统一提示

### T1.9 Context Commands

**目标**：为上下文和会话提供最小控制能力。

**关键输出**：

1. `/session`
2. `/memory`
3. `/context`
4. `/diff`
5. `/providers`
6. `/skills`
7. `/hooks`
8. `/init`

**依赖**：T1.2

**验收**：

1. 用户可查看和切换关键上下文状态
2. 与持久化和权限模型一致

### T1.10 Permission System

**目标**：落地 `default / plan / auto / acceptEdits / bypassPermissions / dontAsk`。

**关键输出**：

1. `PermissionManager`
2. 工具风险分级
3. 审批状态持久化
4. CLI 审批卡片

**依赖**：T1.6

**验收**：

1. 读、写、bash、删除等行为按矩阵执行
2. 审批可 approve / deny / cancel
3. 进程重启后未决审批可恢复

### T1.11 CLI REPL

**目标**：交付可用 TUI 主界面和输入循环。

**关键输出**：

1. `AppShell`
2. `Header`
3. `TranscriptPane`
4. `StatusBar`
5. `ApprovalPanel`
6. `Composer`
7. `FooterHints`

**依赖**：T1.2

**验收**：

1. 主界面与设计原型一致
2. 支持纯键盘操作
3. Ink 失败时可降级为文本 REPL

### T1.12 Ingress Gateway

**目标**：统一会话入口和消息路由，为后续渠道扩展打底。

**关键输出**：

1. `IngressMessage`
2. `SessionManager`
3. `IngressGateway`
4. Delivery 抽象

**依赖**：T1.9

**验收**：

1. CLI 入口走统一 Ingress 流程
2. sessionId、traceId、channel 元信息完整

### Phase 1 收尾任务

**必须补齐**：

1. 20 条 transcript golden tests
2. 5 类工具权限路径测试
3. 启动 / setup / resume / approval 的基础回归测试
4. Phase 1 交付说明文档

---

## 5. Phase 1.5: 基础 LSP

### T1.5.1 LSPTool 骨架

**目标**：引入可降级的 LSP 能力，而不是强依赖 LSP。

**关键输出**：

1. `LSPTool`
2. symbol / definition / references 查询
3. LSP 启动失败回退逻辑

**依赖**：T1.7

**验收**：

1. 支持至少一类主流语言的 LSP 查询
2. LSP 不可用时自动回退到 grep/glob 路径

### T1.5.2 Symbol Index

**目标**：建立最小符号索引能力。

**关键输出**：

1. 进程内 symbol cache
2. workspace 级索引入口
3. 索引刷新策略

**依赖**：T1.5.1

**验收**：

1. 单仓库中可按 symbol 查询文件与引用
2. 索引错误不会阻塞主流程

---

## 6. Phase 1.9: 持久化增强

### T1.9.1 SQLite 镜像索引

**目标**：在不破坏 JSONL 原始日志的前提下增强查询能力。

**关键输出**：

1. SQLite schema
2. session / approval / usage 镜像表
3. migration 入口

**依赖**：T1.12

**验收**：

1. JSONL 仍为原始事实来源
2. SQLite 可用于查询与恢复加速

### T1.9.2 恢复能力增强

**目标**：提升重启后 session 和 approval 的恢复体验。

**关键输出**：

1. recovery summary
2. resumable session 列表
3. approval resume 流程

**依赖**：T1.9.1

**验收**：

1. 重启后可恢复最近一次未完成任务
2. 未决审批可继续处理

---

## 7. Phase 2: 智能编排

### T2.1 Codebase Graph + Symbol Index 增强

**目标**：从基础 symbol 查询升级到更稳定的代码定位能力。

**关键输出**：

1. codebase graph 骨架
2. import / reference 关系查询
3. 图谱增量更新入口

**依赖**：T1.5.2

**验收**：

1. 能回答“这个函数被谁调用”
2. 图谱失败时不阻塞普通检索

### T2.2 Planner

**目标**：引入可验证的 Goal Planner。

**关键输出**：

1. `IntentParser`
2. `GoalPlanner`
3. `GoalDefinition`
4. `completionChecks`

**依赖**：T2.1

**验收**：

1. 每个 Goal 都有显式完成检查
2. 无检查项的 Goal 不进入执行态

### T2.3 Executor

**目标**：实现任务执行器和顺序/DAG 调度能力。

**关键输出**：

1. `Executor`
2. task scheduling
3. 工具调用编排
4. 执行结果归档

**依赖**：T2.2

**验收**：

1. 能执行简单多步任务
2. 每一步都写入 observation

### T2.4 Reflector

**目标**：做基于检查结果的纠偏，而不是自评完成。

**关键输出**：

1. `Reflector`
2. gap 分类
3. retry / replan / escalate 路径
4. loop detection

**依赖**：T2.3

**验收**：

1. Reflector 仅基于工具结果和 checks 判断
2. 相同失败重复出现时能 escalated

### T2.5 SDK/HTTP API

**目标**：复用同一 Agent Loop 和 Session 语义提供外部入口。

**关键输出**：

1. HTTP API
2. SSE streaming
3. SDK wrapper
4. API auth 骨架

**依赖**：T1.12

**验收**：

1. SDK/HTTP 与 CLI 共享会话语义
2. 流式输出与中断恢复行为一致

### T2.6 MCP 集成

**目标**：接入外部工具与资源协议。

**关键输出**：

1. MCP transport
2. MCP tool call
3. read/list resource
4. MCP 审批入口

**依赖**：无

**验收**：

1. 至少能连 1 个本地 MCP server
2. MCP 工具受权限模型约束

### T2.7 Remaining Commands

**目标**：补齐核心生产力命令。

**关键输出**：

1. `/doctor`
2. `/review`
3. `/export`
4. `/summary`
5. `/reload-plugins`
6. `/debug-tool-call`

**依赖**：T1.8

**验收**：

1. 命令能复用既有核心模块
2. 不因命令扩展破坏主界面稳定性

### T2.8 Skill System

**目标**：接入 SKILL.md 驱动的预定义工作流。

**关键输出**：

1. `SkillRegistry`
2. skill discovery
3. skill prompt injection
4. allowedTools 约束

**依赖**：T1.9

**验收**：

1. 至少 3 个内建 skill 可运行
2. skill 不可用时可回退到普通流程

### Phase 2 收尾任务

**必须补齐**：

1. 10 个真实任务样例回放
2. Planner / Executor / Reflector 集成测试
3. SDK/HTTP API 文档与示例

---

## 8. Phase 3: 高级能力

### T3.1 Agent Team

**目标**：引入受控多 Agent，不作为默认路径。

**关键输出**：

1. leader / worker 协议
2. 子任务分发
3. blackboard 汇总
4. 并发预算控制

**依赖**：T2.6

**验收**：

1. 默认关闭
2. 至少一个明确工作流可证明收益

### T3.2 LSP 深度增强

**目标**：提升 symbol / reference / graph 准确度。

**关键输出**：

1. 多语言策略
2. 增量刷新
3. 调用链增强

**依赖**：T1.5

**验收**：

1. 对大型代码库仍可工作
2. 失败可回退

### T3.3 L4 Context Collapse

**目标**：实验性上下文重构压缩。

**关键输出**：

1. collapse 结构
2. 兼容既有 compact summary
3. 指标记录

**依赖**：T1.4

**验收**：

1. 开关可控
2. 关闭时不影响主流程

### T3.4 L5 Micro-Compact

**目标**：进一步降低缓存和上下文浪费。

**关键输出**：

1. micro compact 触发器
2. cache 事件监听
3. compact 同步逻辑

**依赖**：T1.4

**验收**：

1. 对缓存型 Provider 不产生错误行为

### T3.5 微信 Bot

**目标**：接入 iLink 微信 Bot，并复用核心会话与审批模型。

**关键输出**：

1. wechat adapter
2. message context mapping
3. markdown card output
4. approval notify / resume

**依赖**：T1.10

**验收**：

1. 微信消息能创建和继续 session
2. 审批状态机与 CLI 一致

### T3.6 插件系统

**目标**：支持本地 / marketplace 插件扩展。

**关键输出**：

1. plugin manifest
2. plugin loader
3. command / skill / hook 注册
4. 插件安全边界

**依赖**：T2.8

**验收**：

1. 至少支持 1 个本地插件
2. 插件崩溃不拖垮主进程

---

## 9. Phase 4: 打磨优化

### T4.1 性能优化

**目标**：将核心链路做到可持续开发和可维护运行。

**关键输出**：

1. 冷启动优化
2. transcript 渲染优化
3. tool output 截断优化
4. 索引懒加载

**验收**：

1. 达到技术文档中的启动目标
2. 长 transcript 不卡顿

### T4.2 错误处理

**目标**：统一错误模型和降级路径。

**关键输出**：

1. error codes
2. user-facing error mapping
3. recovery hints
4. telemetry/logging 结构完善

**验收**：

1. 高频错误都有用户可理解的提示
2. 崩溃率显著下降

### T4.3 测试覆盖

**目标**：补齐单测、集成、回放、恢复测试。

**关键输出**：

1. transcript golden suite
2. permission matrix tests
3. provider mock tests
4. UI interaction tests
5. recovery tests

**验收**：

1. 核心路径全部受测试保护
2. 版本迭代可稳定回归

---

## 10. 推荐执行顺序

若为单人开发，建议按下面顺序推进，而不是机械按章节并行：

1. T1.0 / T1.0.1 工程脚手架与开发环境
2. T1.1 Provider 抽象层
3. T1.6 File Tools
4. T1.7 Shell Tool
5. T1.2 Agent Loop 核心
6. T1.10 Permission System
7. T1.11 CLI REPL
8. T1.3 / T1.4 / T1.5 Compact 三件套
9. T1.12 Ingress Gateway
10. T1.8 / T1.9 命令系统
11. T1.5.1 / T1.5.2 基础 LSP
12. T1.9.1 / T1.9.2 持久化增强
13. T2.2 / T2.3 / T2.4 智能编排
14. T2.5 / T2.6 / T2.8 扩展入口
15. T3.* 高级能力
16. T4.* 打磨与回归

---

## 11. 每周里程碑建议

| 周次 | 重点任务 | 周末应可展示内容 |
|------|----------|------------------|
| W1 | T1.0 + T1.1 + T1.6 | 工程脚手架、Provider、文件工具可用 |
| W2 | T1.7 + T1.2 + T1.10 | CLI 可对话、可调用工具、可审批 |
| W3 | T1.11 + T1.3 + T1.4 | 可用 TUI + 自动 compact |
| W4 | T1.5 + T1.8 + T1.9 + T1.12 | 可恢复会话的核心闭环 |
| W5 | T1.5.1 + T1.5.2 + T1.9.1 + T1.9.2 | LSP 可选增强 + 持久化恢复增强 |
| W6 | T2.1 + T2.2 | 基础 Planner 可产出带 checks 的任务 |
| W7 | T2.3 + T2.4 + T2.5 | 可验证的多步任务闭环 + HTTP/SDK |
| W8 | T2.6 + T2.7 + T2.8 | MCP / Skill / 命令增强 |
| W9 | T3.2 + T3.6 | LSP 深化 + 插件基础 |
| W10 | T3.1 + T3.3 + T3.4 + T3.5 | 微信与高级能力实验版 |
| W11 | T4.1 + T4.2 | 性能与错误治理 |
| W12 | T4.3 | 测试收口与发布准备 |

---

## 12. Definition of Done

任务完成必须同时满足：

1. 代码已合入或已在主分支验证
2. 对应验收标准有实际验证结果
3. 关键日志、错误处理、权限路径已覆盖
4. 相关文档已同步
5. 若新增命令、工具、状态或配置，已补测试

---

## 13. 发布前检查

### v0.5-alpha

1. Phase 1 全部完成
2. transcript 回放通过
3. 启动、setup、approval、resume 无阻断问题

### v0.5-beta

1. Phase 2 全部完成
2. SDK/HTTP 可用
3. Planner / Executor / Reflector 有真实样例支撑

### v0.5-stable

1. Phase 4 完成
2. 关键崩溃问题关闭
3. 有完整安装、升级、恢复文档

---

## 14. 文档维护

1. 新增任务时，优先扩展已有 Phase，不新开无边界的“杂项”章节
2. 任务延期时，要记录原因是范围扩大、技术阻塞还是验收未过
3. 已取消任务要标明原因，不直接删除
