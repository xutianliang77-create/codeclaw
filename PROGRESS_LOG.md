## 📌 SESSION HANDOFF STATUS
### Current Work: v0.5 已进入 Phase 1.5.2 的结果质量增强阶段：真实 `multilspy` backend 已默认优先接入 CLI 主流程，`/glob` 的旧回归也已修复；同时 `/definition` 已修正为真正的 definition 查询，`references` 覆盖率、去重/排序和多语言 backend 选择也完成了一轮增强
### Background Tasks: 无常驻后台进程
### Next Session Priorities:
1. 继续排查 TUI + IME 兼容；在此之前建议优先使用 `--plain`
2. 继续优化真实 LSP backend 的结果质量，尤其是更复杂项目下的 references 覆盖率、更多语言的真实 backend 选择，以及 TS/JS 的 symbol/documentSymbol 排序
3. 根据需要继续推进下一阶段功能，而不是再卡在基础设施收尾上
3. 修复 `test/query-engine.test.ts` 里现有的 `/glob src/**/*.ts` 回归；这次在完整回归时暴露出来，但与 multilspy 安装无关
3. 继续扩展语言规则和排序策略，尤其是 Java/C#/C-family 的误报控制
4. 在 T2.5 基础上补更细粒度中断/会话管理和更完整的 API 文档样例
### Resume Checklist:
1. `cd /Users/xutianliang/Downloads/codeclaw`
2. `npm install`
3. `npm run lint`
4. `npm run typecheck`
5. `npm run test`
6. `bun run build`
7. `npm run dev`
8. 在 REPL 中输入 `help`

### Completed This Session
1. 创建最小工程脚手架：`package.json`、`tsconfig.json`、`eslint.config.js`、`scripts/build.mjs`
2. 创建最小 CLI/TUI 入口：`src/cli.tsx`、`src/app/App.tsx`
3. 实现配置读写：`config.yaml` 与 `providers.json`
4. 实现 `setup`、`doctor` 命令
5. 实现 Provider 抽象层第一版：builtin definitions、ProviderRegistry、selection、local health probe
6. 补齐 provider 相关测试并跑通 `lint/typecheck/test/build`
7. 完成交互式 Provider 配置界面，新增 `config` 命令入口与 Ink 配置 UI
8. 新增 `QueryEngine` 最小骨架和流式事件接口
9. 把 `App.tsx` 从假回复切到真实 `QueryEngine` 消费循环
10. 新增 Provider 请求层 `src/provider/client.ts`
11. 接入 Anthropic / OpenAI-compatible / Ollama 的流式解析
12. 新增最小权限骨架 `src/permissions/manager.ts`
13. 新增本地工具 `src/tools/local.ts`，支持 `/read` 与 `/bash`
14. 新增 `test/query-engine.test.ts`、`test/provider-client.test.ts`、`test/permission-manager.test.ts`、`test/local-tools.test.ts`
15. 为 QueryEngine 增加 `tool-start` / `tool-end` 事件
16. 让 UI 状态栏显示工具运行状态
17. 新增 `/write`、`/append`、`/replace` 本地工具
18. 扩展权限分级到 write/edit 类操作
19. 为 `plan/default` 模式新增最小审批状态机：`approval-request`、`/approve`、`/deny`
20. 为 UI 新增审批面板与 `approval-cleared` 事件
21. 增加审批态下的 `a` / `d` 快捷批准与拒绝
22. 新增审批文件存储与重启恢复能力
23. 为本地工具引入结构化结果：`LocalToolExecutionResult` / `LocalToolExecutionError`
24. 抽取通用工具协议到 `src/tools/types.ts`
25. 新增 `kind`、`errorCode`、`payload.summary/detail` 结构，保留原有文本输出兼容 UI
26. 验证 `lint`、`typecheck`、`test`、`build`
27. 用临时 `HOME` 实际启动默认 REPL，确认 `/read package.json`、`/bash pwd` 可运行，`/write tmp.txt :: hello` 会先进入审批态且可通过 `a` 快捷批准
28. 用同一 `HOME` 重启 REPL，确认挂起审批会恢复，并可通过 `d` 快捷拒绝
29. 为 QueryEngine 增加 Provider fallback 语义：仅在主 Provider 尚未产出任何流式内容时才允许回退
30. 为主 Provider 中途断流场景增加保护：保留已产出的部分内容，并追加 `[stream interrupted: ...]` 提示，不再切换到 fallback 混入第二路输出
31. 补齐 Provider fallback 与流式中断测试
32. 为 QueryEngine 增加最小核心 slash commands：`/help`、`/status`、`/resume`、`/session`、`/providers`、`/context`、`/memory`、`/compact`
33. 为 QueryEngine 增加可变状态命令：`/model <name>` 与 `/mode <permission-mode>`
34. 让 App 头部跟随会话内 `model/mode` 变化刷新显示
35. 为状态命令和 `/mode` 权限切换补齐单元测试
36. 实现手动 `/compact`：压缩旧对话、保留最近窗口，并生成包含 goals / key files / open items 的摘要消息
37. 让 `/context` 返回 compact 状态、最近 compact 摘要和压缩计数
38. 为手动 compact 补齐单元测试
39. 将审批存储从单条 pending 升级为持久化审批队列
40. 允许在已有待审批任务时继续创建新的待审批工具请求
41. 为 `/approve`、`/deny` 实现队首顺序处理，并在重启后恢复整条审批队列
42. 为多审批顺序执行和跨 session 恢复补齐单元测试
43. 为审批队列增加定向 `/approve <id>` 与 `/deny <id>` 处理
44. 在审批面板中展示当前审批 id，支持按 id 精确处理
45. 为定向审批和未知 id 错误反馈补齐单元测试
46. 为 QueryEngine 接入 `autoCompactThreshold` 配置，并在 CLI 启动链路中传递 L1 阈值
47. 实现普通对话输入下的 Proactive Auto-Compact 触发器，命令输入不触发自动 compact
48. 让 `/context` 与 `/status` 输出 `estimated-tokens`、`auto-compact-threshold` 和 `auto-compacts` 指标
49. 为自动 compact 触发和上下文指标补齐单元测试
50. 为 Provider 非 2xx 响应引入结构化 `ProviderRequestError`
51. 实现上下文超限场景下的 Reactive Compact：413 / context-too-long 时自动 compact 并重试一次
52. 为 `/context` 与 `/status` 增加 `reactive-compacts` 指标
53. 为 Reactive Compact 恢复路径补齐单元测试
54. 实现最小 `IngressMessage` / `ResolvedIngressMessage` / `DeliveryEnvelope` 统一入口模型
55. 实现 `SessionManager`，支持 `channel:userId → sessionId` 映射
56. 实现 `IngressGateway`，统一处理 CLI 消息、session 绑定和 delivery 封装
57. 让 CLI App 提交和中断统一走 Ingress Gateway，而不是直接调用 QueryEngine
58. 为 Ingress Gateway 的元数据、session 映射和 CLI 入口补齐单元测试
59. 实现 `codeclaw gateway` 命令，启动本地 HTTP gateway
60. 实现 `GET /health`、`POST /v1/messages`、`POST /v1/interrupt` 最小 HTTP API
61. 为 `POST /v1/messages` 提供 JSON 响应和 SSE 流式两种模式
62. 实现本地 `CodeClawSdkClient`，封装 `healthCheck / sendMessage / streamMessage / interrupt`
63. 增加 bearer auth 骨架：`CODECLAW_GATEWAY_TOKEN`
64. 为 HTTP handler、SDK wrapper 和 auth 骨架补齐无端口依赖的单元测试
65. 补充 [docs/HTTP_API.md](/Users/xutianliang/Downloads/codeclaw/docs/HTTP_API.md) 文档
66. 补充 [examples/http-client.mjs](/Users/xutianliang/Downloads/codeclaw/examples/http-client.mjs) 与 [examples/sdk-client.ts](/Users/xutianliang/Downloads/codeclaw/examples/sdk-client.ts) 示例客户端
67. 为本地工具补齐 `GlobTool`，新增 `/glob <pattern>` 命令
68. 为 QueryEngine 补齐 `/approvals`、`/diff`、`/skills`、`/hooks`、`/init` 等 Phase 1 收尾命令
69. 为会话内文件活动增加最小跟踪，`/memory` 可显示 recent-reads / changed-files，`/diff` 可显示 session-tracked edits
70. 为 App 增加本地 `/exit` 退出处理，并更新界面 footer hints
71. 新增 [docs/PHASE1_DELIVERY.md](/Users/xutianliang/Downloads/codeclaw/docs/PHASE1_DELIVERY.md) 作为 Phase 1 交付说明
72. 新增 `test/command-regression.test.ts`，覆盖 `setup / config / doctor` 的基础回归路径
73. 为 `query-engine` 补齐 glob、approvals、memory、diff、skills/hooks/init 等 transcript 回归测试
74. 为 `local-tools` 补齐 glob 匹配测试
75. 完成 Phase 1 计划收口并重新验证 `lint/typecheck/test/build`
76. 修复 provider transcript 污染：provider 请求不再直接透传 UI transcript，而是只发送真实 user turns 与 compact summary
77. 修复 `/approve` / `/deny` 前缀误判，避免 `/approvals` 之类命令被误识别
78. 新增 provider 空回复保护：stream 成功但无文本时返回 `Provider returned an empty response.`
79. 为 transcript 过滤、`/approvals` 命令匹配和空回复保护补齐回归测试
80. 为 `App.handleSubmit()` 增加回合级异常保护，输入/执行期异常改为显示在 UI 中，而不是直接把进程打掉
81. 为所有 `render(...)` 显式关闭 Ink 默认 `exitOnCtrlC`，统一交由应用层处理
82. 为 `src/cli.tsx` 增加顶层 `main().catch(...)`，避免启动期异常静默退出
83. 将 provider 请求超时从“整个 streaming 生命周期超时”改为“连接/首响应阶段超时”，避免 LM Studio / Ollama 正常生成过程中被中途 abort
84. 为本地 provider 设置更合理的默认连接超时：`60s`
85. 为“极小 timeoutMs 下本地流仍能正常完成”补齐 provider-client 回归测试
86. 新增 `--plain` 文本 REPL，作为 IME/raw-mode 不稳定场景下的安全降级模式
87. 为 `src/cli.tsx` 增加 crash logging，未捕获异常会写入 `~/.codeclaw/logs/crash.log`
88. 新增 `src/lsp/service.ts`，实现可降级的 regex-backed LSPTool 骨架
89. 新增 `querySymbols / queryDefinitions / queryReferences` 和进程内 workspace symbol cache
90. 将 `/symbol`、`/definition`、`/references` 接入现有工具链、权限模型和 transcript
91. 为 LSP fallback service、local tool、query-engine 三层补齐测试
92. 为 workspace symbol index 增加元数据：`sourceFileCount / symbolCount / builtAt`
93. 增加按文件变化刷新的索引策略：查询前自动刷新，写工具后主动 invalidate
94. 让 symbol/definition/references 输出携带当前 index 规模信息
95. 为索引刷新和文件变更后的 symbol 可见性补齐测试
96. 扩展语言规则和文件扩展名支持：Kotlin、Ruby、PHP、Swift、C#、C/C++ 等
97. 增强定义排序：exact/prefix 优先，其次按 symbol kind 优先级排序
98. 增加 references 去重，并将 definition 位置排在 references 前面
99. 新增 `src/lsp/backend.ts`，显式表达 real backend candidate（`multilspy`）与 fallback-regex-index 的双轨评估结果
100. 让 LSP 查询输出带上 real backend candidate 状态，便于后续切换真实 backend
101. 为真实 LSP backend 增加可执行桥接层：`src/lsp/backend.ts` 现在不只做 probe，还会在 `CODECLAW_ENABLE_REAL_LSP=1` 且 `multilspy` 可导入时返回可执行的 `RealLspBackend`
102. 新增 `scripts/lsp_multilspy_bridge.py`，建立 Python 侧桥接协议：`--kind/--workspace/--query -> JSON`
103. 为真实 backend 增加桥接失败自动回退，避免桥接异常直接打断 `/symbol`、`/definition`、`/references`
104. 修正 LSPTool 输出文案：只有 `result.degraded === true` 时才显示 `(degraded)`
105. 为真实 backend 桥接补齐单元测试：覆盖“bridge 成功走 multilspy 路径”和“bridge 返回 error 时回退到 regex index”两条主路径
106. 在仓库内创建 `.venv-lsp`，并把 `multilspy` 安装到本地虚拟环境，避免污染系统 Python
107. 让 `src/lsp/backend.ts` 自动优先发现仓库内 `.venv-lsp/bin/python`，减少手动配置成本
108. 验证本地 `.venv-lsp` 可成功导入 `multilspy`
109. 将 `scripts/lsp_multilspy_bridge.py` 从 regex scaffold 升级为真实 multilspy 桥接：
110. 真实 `/symbol`、`/definition`、`/references` 现在会调用 `SyncLanguageServer`
111. 为 TS/JS 的 `/symbol` 改走 `documentSymbol`，绕过 `workspace/symbol` 的 `No Project` 错误
112. 在桥接脚本里加入总超时保护，避免真实 LSP 初始化把 CLI 命令无限挂住
113. 在桥接脚本里绕过 multilspy 清理阶段的 `psutil/sysctl` 权限问题，避免 macOS 沙箱下 `definition/references` 直接报错
114. 将 multilspy 所需的 `typescript-language-server@4.3.3` 与 `typescript@5.5.4` 安装到 multilspy 期望的 static 路径
115. 验证最小 TypeScript 工作区下，真实 backend 已可返回 symbol / definition / references 三类结果
116. 定位出当前仓库真实 backend 超时的根因：桥接脚本和 fallback index 都错误地把 `.venv-lsp` 当成工作区内容扫描，导致主语言误判和启动变慢
117. 在 `scripts/lsp_multilspy_bridge.py` 与 `src/lsp/service.ts` 中新增跳过目录：`.venv`、`.venv-lsp`、`__pycache__`
118. 新增回归测试：workspace index 不应把 `.venv-lsp` 中的 Python 文件算进工作区
119. 修复后，当前 `codeclaw` 仓库上的真实 multilspy `definition/references` 查询已经可以直接返回结果
120. 调整 `src/lsp/backend.ts` 的启用策略：未设置 `CODECLAW_ENABLE_REAL_LSP` 时改为自动优先真实 backend；显式 `0/false/off` 时才强制回退
121. 保留显式开关：`1/true/on` 强制尝试真实 backend，`0/false/off` 强制关闭
122. 更新相关单测：默认未设置时自动优先真实 backend，显式关闭时仍能稳定走 fallback-regex-index
123. 实机验证 CLI 主流程：重建后的 `node dist/cli.js --plain` 执行 `/definition createQueryEngine` 时，已显示 `LSPTool backend: multilspy`
124. 修复 `/glob` 的独立旧回归：`src/tools/local.ts` 的文件收集现在也会跳过 `.venv`、`.venv-lsp`、`__pycache__`
125. 为 `/glob` 增加回归测试，防止以后再次把虚拟环境目录纳入匹配范围
126. 全量回归重新打绿：`npm run test` 当前共 65 个测试，全部通过
127. 修复 `src/lsp/service.ts` 中的一个质量问题：`queryDefinitions()` 之前只是复用了 `querySymbols()` 并取第一条，现在已改为真正调用 `realBackend.queryDefinitions()`
128. 调整相关单测，使 fake real-backend 能区分 `symbol` 和 `definition` 返回，从而防止未来再次把 definition 路径误接到 symbol 查询
129. 增强 `scripts/lsp_multilspy_bridge.py` 的多语言 backend 选择策略：不再只看“工作区主语言”，而是优先根据锚点文件语言选择候选 backend，再补工作区中最常见的其他候选语言
130. 扩大真实 `references` 覆盖率：同一查询现在会基于多个锚点位置发起 LSP 查询，而不是只依赖单个最佳锚点
131. 改进真实 `references` 的去重与排序：去重粒度从 `file:line` 提升到 `file:line:column`，因此同一行多个引用不会被错误折叠；排序上优先 definition、优先锚点同文件、再按路径深度与位置排序
132. 新增真实桥接回归测试 `test/lsp-bridge.test.ts`
133. 验证“同一行多个 references 不会丢失”
134. 验证“混合语言工作区里会优先选择锚点语言对应的真实 backend”

### Verification Snapshot
1. `npm run lint` 通过
2. `npm run typecheck` 通过
3. 定向验证通过：`test/lsp-service.test.ts` 在默认模式下 7/7 通过；显式开启 `CODECLAW_ENABLE_REAL_LSP=1` 后，“真实 backend 命中”和“桥接失败回退”两条路径也通过
4. 实机验证通过：最小 TS 工作区下，`scripts/lsp_multilspy_bridge.py` 已能返回真实 `degraded: false` 的 symbol / definition / references 结果
5. 实机验证通过：当前 `codeclaw` 仓库下，真实 multilspy `definition createQueryEngine` 与 `references createQueryEngine` 已返回 `degraded: false` 结果
6. 实机验证通过：CLI plain REPL 主流程下，未设置 `CODECLAW_ENABLE_REAL_LSP` 时 `/definition createQueryEngine` 默认显示 `LSPTool backend: multilspy`
7. 当前全量验证通过：`typecheck / build / test` 均通过，测试总数 65
8. 当前定向验证通过：`test/lsp-service.ts`、`test/local-tools.ts`、`test/query-engine.ts` 均通过；实机 `scripts/lsp_multilspy_bridge.py --kind definition --query createQueryEngine` 返回真实 `degraded: false` 结果
9. 当前全量验证通过：`npm run test` 共 67 个测试，全部通过；`typecheck / build` 也通过
4. `bun run build` 通过
5. `node dist/cli.js --version` 可输出 `0.5.0`
6. `node dist/cli.js setup`、`node dist/cli.js config` 与 `node dist/cli.js doctor` 已用临时 HOME 验证
7. `node dist/cli.js` 已用临时 HOME 启动验证，REPL 和无 provider 提示可正常渲染
8. 真实 Provider 流式解析通过单元测试验证，尚未使用真实远端 API key 做在线冒烟
9. 默认 REPL 下 `/read package.json` 与 `/bash pwd` 已实机验证
10. `/read` 会产生 `tool-start/tool-end` 事件，UI 状态栏可显示工具状态
11. `/write`、`/append`、`/replace` 已落地；`plan` 模式下写操作会先进入待审批状态
12. `QueryEngine` 已支持 `/approve`、`/deny`，批准后可继续执行挂起工具
13. 默认 REPL 里审批面板已可见，`a` 快捷键可批准挂起写操作
14. 挂起审批已支持本地文件持久化恢复，重启后会恢复审批面板
15. 本地工具结果已统一为通用结构化结果，包含 `kind/errorCode/payload`
16. Provider fallback 已验证：主 Provider 在首字节前失败时会切到 fallback；若已产生部分输出后断流，则保留部分输出并追加中断说明
17. 最小核心 slash commands 已可执行并返回统一文本反馈；`/model` 与 `/mode` 会更新当前会话状态
18. 手动 `/compact` 已可用：会压缩旧消息、保留最近消息窗口，并生成可继续传给后续回合的摘要消息
19. 审批队列已可用：支持多条待审批工具按顺序恢复和跨 session 继续处理
20. 审批队列已支持定向 id 处理：可用 `/approve <id>` 或 `/deny <id>` 跳过队首，按指定审批项执行
21. Proactive Auto-Compact 已可用：普通对话超过阈值会在回合开始前自动 compact，并记录 compact 相位与指标
22. Reactive Compact 已可用：Provider 返回 413 / context-too-long 时会自动 compact 并重试一次
23. T1.12 Ingress Gateway 已可用：CLI 入口已走统一 Ingress 流程，并具备 sessionId / traceId / channel 元信息
24. T2.5 SDK/HTTP API 已可用：本地 gateway 支持 health、JSON、SSE 和 SDK wrapper，且复用同一 Session 语义
25. HTTP API 文档和示例客户端已补齐，可直接作为外部接入参考
26. Phase 1 收尾命令和工具已补齐：`/glob`、`/approvals`、`/diff`、`/skills`、`/hooks`、`/init` 已可执行
27. Phase 1 交付说明文档已补齐，当前可按 [docs/PHASE1_DELIVERY.md](/Users/xutianliang/Downloads/codeclaw/docs/PHASE1_DELIVERY.md) 作为收口说明
28. provider 请求上下文已收敛到真实会话消息，不再把启动欢迎语、slash commands 和本地工具回显直接发给模型
29. 本地 provider 流式回复不再因全局 `timeoutMs` 在生成中途被中断；当前 `timeoutMs` 只用于连接/首响应阶段
30. Phase 1.5.1 已有可用骨架：`/symbol`、`/definition`、`/references` 已能在无 LSP server 场景下工作，并明确标识 `fallback-regex-index`
31. Phase 1.5.2 第一版已可用：workspace symbol index 支持缓存、元数据、自动刷新和写后失效
32. Phase 1.5.2 增强版已可用：更多语言规则、定义优先级、引用去重和 backend assessment 都已落地
33. 真实 backend 桥接链路已可用：启用 `CODECLAW_ENABLE_REAL_LSP=1` 且 Python 里可导入 `multilspy` 时，Node 侧会走桥接脚本；桥接异常时会自动回退到 regex index
34. 当前机器已具备真实 backend 运行前提：`.venv-lsp` 中可导入 `multilspy`
35. 当前机器的 multilspy TypeScript runtime 依赖也已就位：`typescript-language-server` 已安装到 multilspy static 目录

### Known Gaps / Blocking Issues
1. 当前 App 已接入 QueryEngine、真实 Provider 请求层、最小 File/Bash/Write/Edit 本地工具，以及统一工具事件模型
2. Provider 真实请求流尚未使用真实远端 API key 做在线冒烟
3. 权限系统已支持最小审批状态机、审批面板、多任务 / 多 session 审批恢复和定向审批，但还没有更复杂的并发语义
4. `/diff` 当前报告的是会话跟踪的编辑文件，而不是完整 git patch
5. `maxRetries`、`headers`、`apiKeyRequiredOverride` 已记录为 TODO，等接第一个非官方网关时再补
6. 当前仓库中的 `scripts/lsp_multilspy_bridge.py` 已升级为真实 multilspy 桥接，但仍缺少针对大工作区的性能优化与更细的语言特化策略
7. 2026-04-22 本轮完整 `npm run test` 暴露了一个与本次安装无关的现有回归：`test/query-engine.test.ts` 中 `/glob src/**/*.ts` 期望失败，当前返回 `[no matches]`
8. 当前已无已知的测试级阻塞问题；后续主要是继续做更高层功能和 LSP 结果质量优化
