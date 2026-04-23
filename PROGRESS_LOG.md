## 📌 SESSION HANDOFF STATUS
### Current Work: v0.5 已从 Phase 1.5 的 LSP 主线继续推进到下一阶段能力探索，最小 `Planner / Executor / Reflector` 主线已接入 QueryEngine；当前支持显式 `/plan <goal>` 与 `/orchestrate <goal>`，并已从“纯检查型 orchestration”推进到“受控执行多种读类动作 + orchestration 级写入审批 + approved 后更稳导出区块锚点 scaffold/patch 执行”的最小执行型主线
### Background Tasks: 无常驻后台进程
### Next Session Priorities:
1. 继续扩展 Executor 的受控动作集合，优先评估是否接入受限 `bash` 验证命令，以及更细粒度的 package-script allowlist
2. 继续做更精确的函数级 patch，让目标函数命中不只依赖文件名/目标词，而是更明确利用 goal 里的符号线索
3. 在当前块级锚点基础上继续减少整文件重写范围，探索更少靠字符串替换的结构化 edit 策略
4. 继续完善 Reflector：加入更明确的 gap 分类、失败记忆和升级策略，而不是只做单轮 replan/escalate
5. 评估是否引入独立的 orchestration transcript/state，避免未来 Planner/Executor/Reflector 扩展时与普通聊天 transcript 过度耦合
### Resume Checklist:
1. `cd <repo-root>`
2. `npm install`
3. `npm run setup:lsp`
4. `npm run lint`
5. `npm run typecheck`
6. `npm run test`
7. `bun run build`
8. `node dist/cli.js --plain`
9. 在 REPL 中输入 `/plan fix src/agent/queryEngine.ts`
10. 在 REPL 中输入 `/orchestrate analyze src/agent/queryEngine.ts`

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
65. 补充 `docs/HTTP_API.md` 文档
66. 补充 `examples/http-client.mjs` 与 `examples/sdk-client.ts` 示例客户端
67. 为本地工具补齐 `GlobTool`，新增 `/glob <pattern>` 命令
68. 为 QueryEngine 补齐 `/approvals`、`/diff`、`/skills`、`/hooks`、`/init` 等 Phase 1 收尾命令
69. 为会话内文件活动增加最小跟踪，`/memory` 可显示 recent-reads / changed-files，`/diff` 可显示 session-tracked edits
70. 为 App 增加本地 `/exit` 退出处理，并更新界面 footer hints
71. 新增 `docs/PHASE1_DELIVERY.md` 作为 Phase 1 交付说明
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
135. 将真实 LSP 运行时纳入标准安装流程：新增 `requirements-lsp.txt`
136. 新增 `scripts/setup-lsp.sh`，统一创建 `.venv-lsp`、安装 `multilspy`、安装 `typescript-language-server` / `typescript`
137. 在 `package.json` 中新增 `npm run setup:lsp`
138. 新增 `docs/LSP_SETUP.md`，说明真实 LSP 的安装与运行策略
139. 新增 `src/orchestration/types.ts`，引入最小编排域模型：`Intent / GoalDefinition / CompletionCheck / ExecutionResult / ReflectorResult`
140. 新增 `src/orchestration/intentParser.ts`、`goalPlanner.ts`、`executor.ts`、`reflector.ts` 和 `index.ts`，形成最小 `Planner / Executor / Reflector` 骨架
141. Planner 现在会为每个 goal 生成显式 completion checks，覆盖 `path-exists / workspace-has-source-files / provider-available / tool-available / package-script-present / permission-mode`
142. Executor 现在会基于工作区、provider、权限模式和 package scripts 执行这些检查，并产出结构化 observations 与 gaps
143. Reflector 现在只基于检查结果决定 `complete / replan / escalated`，并修复了“重复失败识别被随机 goalId/checkId 干扰”的根因
144. 在 `src/agent/queryEngine.ts` 中接入显式 `/plan <goal>` 与 `/orchestrate <goal>` 命令，不影响普通聊天和现有工具流
145. `/orchestrate` 当前会跑一轮 `planner -> executor -> reflector`，并在 QueryEngine 内维护最近 gap signatures，用于识别重复失败并升级
146. 新增 `test/orchestration.test.ts`，覆盖“显式 completion checks”“基于检查失败的 replan”“重复 gap 的 escalated”
147. 扩展 `test/query-engine.test.ts`，覆盖 `/plan`、`/orchestrate` 和重复 gap 升级的主流程
148. 全量校验重新通过：`lint / typecheck / test / build` 全绿，当前共 12 个测试文件、73 个测试
149. 将 `GoalDefinition` 从“只有 completion checks”扩展为“completion checks + execution actions”
150. 新增最小受控动作模型：`inspect-file`、`inspect-symbol`、`inspect-pattern`、`run-package-script(typecheck)`
151. Planner 现在会根据目标自动生成少量安全动作：文件目标会触发 `inspect-file`，函数/符号目标会触发 `inspect-symbol`，分析类缺少显式目标时会用 `inspect-pattern`
152. Validation goal 现在在 `create/fix` 场景下不只检查 `typecheck` 脚本存在，还会实际执行 allowlisted `typecheck`
153. Executor 现在在 checks 全部通过后，会顺序执行这些安全动作，并把结果写入 `actionLogs` 与结构化 observations
154. QueryEngine 的 `/plan` 输出现在会显示每个 goal 的 `actions`
155. QueryEngine 的 `/orchestrate` 输出现在会显示 `actions-run` 与 `action-logs`
156. 新增 orchestration 动作级测试，验证文件检查、符号检查和 `typecheck` 脚本执行都会真实发生
157. 全量校验再次通过：当前共 12 个测试文件、74 个测试
158. 将读类 orchestration 动作继续扩展：新增 `inspect-references`
159. Planner 现在在识别到函数/符号目标时，会同时生成 `inspect-symbol` 与 `inspect-references`
160. Planner 现在在识别到显式文件目标时，还会补一层目录级 `inspect-pattern`，用于查看相邻源码文件
161. Executor 已支持真实执行 `/references`，并把引用检查写入 observations 与 action-logs
162. `/plan` 与 `/orchestrate` 输出现在会显式展示 `write-lane` 评估，说明为什么当前 executor 仍保持 read-only，不直接接写工具
163. 新增测试覆盖：`inspect-references` 会真实执行；`/plan` 和 `/orchestrate` 会展示 `write-lane` / `action-logs`
164. 全量校验保持通过：当前仍为 12 个测试文件、74 个测试
165. 新增 orchestration 动作 `request-write-approval`，用于把潜在写操作显式建模进执行计划
166. `create / fix / task` 且带目标文件时，Planner 现在会生成写入审批动作，而不是静默假设后续可直接写文件
167. Executor 现在会把这类动作转成结构化 `approvalRequests`，状态初始为 `pending`，并写入 `actionLogs`
168. Reflector 现在会优先识别 `pending approval`，并返回新决策 `approval-required`
169. 新增 `reflectOnApprovalOutcome()`，可对 orchestration 审批的 `approved / denied / timed_out` 给出明确反思结果
170. QueryEngine 现在维护独立的 orchestration pending approval 队列，不和现有本地工具 pending approval 队列混用
171. `/approvals` 现在会同时列出本地工具审批和 orchestration 审批
172. `/approve`、`/deny` 在本地工具审批队列为空时，会继续处理 orchestration 审批
173. orchestration 审批被 `approved` 后，会返回 `reflector-decision: replan` 和 follow-up goals；被 `denied` 后，会返回 `reflector-decision: escalated`
174. 新增测试覆盖：`approval-required` 决策、`/approvals` 中的 orchestration 条目、以及 orchestration `/approve` `/deny` 路径
175. 全量校验再次通过：当前共 12 个测试文件、78 个测试
176. 新增 `src/orchestration/approvalExecution.ts`，专门负责把已批准的 orchestration approval 物化成真正的本地工具执行计划
177. 当前已批准的 orchestration `write` 会被物化成真实 `/write`，`replace` 会在读取目标文件后物化成真实 `/replace`
178. 为了保持“非自动生成内容”的边界，approved 后写入的内容目前是 deterministic placeholder，而不是模型生成的实现代码
179. `QueryEngine` 在处理已批准的 orchestration approval 时，现在会真正触发本地 `write/replace` 工具、产出 `tool-start/tool-end`，并把结果写回 transcript
180. orchestration 审批批准回复现在会带 `tool-output`
181. 新增测试覆盖：`buildApprovedExecutionPlan()` 会正确生成 `write/replace` 命令；`/approve` 后会真实创建文件或修改目标文件
182. 全量校验再次通过：当前共 12 个测试文件、80 个测试
183. 将 approved 后的 `write` 语义从“通用 placeholder 文本”升级为“语言感知 scaffold”
184. 目前 `.ts/.js` 会生成带导出函数和输入接口的确定性 scaffold，`.tsx/.jsx` 会生成组件 scaffold，`.py` 会生成确定性函数 scaffold，`.md` 会生成结构化文档 scaffold
185. 将 approved 后的 `replace` 语义从“仅在首行前塞 placeholder”升级为“保留原锚点 + 注入确定性 patch snippet”
186. 目前 `.ts/.js` 会插入 `apply<PascalCase>NameApprovedPatch` 一类确定性 patch 导出，其他语言也会按扩展名生成更接近实际代码结构的 patch
187. 更新测试覆盖：approved 后创建的新文件现在断言真实 scaffold 结构；approved 的 replace 现在断言真实 patch 导出而不是 placeholder 注释
188. 全量校验保持通过：当前仍为 12 个测试文件、80 个测试
189. 进一步收紧 replace 锚点：approved 后的 replace 不再只盯单行，而是优先定位“最后一个函数/类代码块”，找不到时才回退到最后一个声明块或最后非空行
190. 当前 `.ts/.tsx/.js/.jsx/.mjs/.cjs` 会优先选最后一个顶层函数/类块作为 patch 锚点，`.py` 会优先选最后一个顶层 `def/class` 块
191. 这让 approved 后的 patch 更接近“函数级 patch”，也降低了把 patch 插到普通常量行后的风险
192. 更新测试覆盖：`buildApprovedExecutionPlan()` 现在断言多行函数块级 replace 锚点；`query-engine` 的 approved replace 用例也改成真实函数块场景
193. 为避免环境波动导致误报，`query-engine` 的 `/orchestrate` 回归在该场景下显式关闭真实 LSP；`lsp-bridge` 的真实桥接测试超时上调到 15 秒
194. 全量校验保持通过：当前仍为 12 个测试文件、80 个测试
195. 将 approved 后的 replace 物化策略从“运行时 `/replace` 替换块文本”改成“先在内存里按锚点块生成完整新文件，再用 `/write` 落盘”
196. 这让 approved 后的 edit 更少依赖脆弱的字符串 replace，也为后续更结构化的 edit 策略留出了更干净的扩展点
197. 新增更稳的导出区块锚点选择策略：会综合 `planGoal` 中的符号线索、文件 stem 派生名、是否导出、是否 `export default` 来选择更合适的插入块
198. 当前在 TS/JS/Python 文件里，如果有更匹配的命名函数/类块，会优先围绕该块插入 patch；若存在 `export default`，也会尽量避免把 patch 粗暴贴在 default 导出后面
199. 更新测试覆盖：approved replace 现在断言 `buildApprovedExecutionPlan()` 生成的是 `/write` 全文件改写计划，而不是 `/replace`
200. 全量校验保持通过：当前仍为 12 个测试文件、80 个测试
201. 继续把 approved replace 推进到更精确的函数级 patch：当 `planGoal` / 文件 stem 与目标函数名命中时，优先在函数体内部插入确定性 no-op patch，而不是继续在函数块后面追加导出 helper
202. 当前 `.ts/.tsx/.js/.jsx/.mjs/.cjs` 会优先把 patch 插到目标函数体内，且尽量落在首个 `return/throw/yield` 之前；`.py` 会优先把 patch 插到目标 `def` 内、落在 `return/raise/yield` 之前
203. 这让 approved edit 更接近“函数级 patch”，同时继续保留原函数签名和主体结构，减少对脆弱字符串 replace 的依赖
204. 修正函数命中条件：不再只认和 `planGoal` 完全同名的符号，当前会接受文件 stem / goal 符号与函数名的部分匹配，例如 `fix existing.ts` 能命中 `existingFeature()`，`fix worker.py` 能命中 `existing_worker()`
205. 更新测试覆盖：TS replace 现在断言 patch marker 被插入目标函数体内；新增 Python replace 回归，断言确定性 marker 会在 `return` 前落入目标函数内部；全量校验再次通过，当前共 12 个测试文件、81 个测试
206. 继续把 approved replace 从“手工拼整文件数组”推进到更明确的结构化 edit 策略：新增 `LineEditPlan`，当前 replace 会先生成 line-edit 计划，再统一应用到源文件行集
207. 当前函数级 patch 和非函数 fallback 都走同一套 line-edit 应用链：命中目标函数时生成“函数体内插入”计划；命不中时生成“锚点块后追加 deterministic patch”计划
208. 这让底层 edit 语义更清晰，也减少了后续扩展更多 edit 类型时继续回到字符串拼接逻辑的风险
209. 新增回归测试：当目标文件没有可命中的函数时，approved replace 仍会在最佳非函数锚点后追加 deterministic patch，保证 fallback 路径不回退
210. 全量校验再次通过：当前共 12 个测试文件、82 个测试
211. 开始补齐 `Phase 2` 扩展入口层，优先落地 `T2.8 Skill System`：新增 `src/skills/registry.ts`，提供 3 个内建 skill（`review` / `explain` / `patch`）及对应 `allowedTools`
212. `/skills` 不再是占位文案：当前支持列出已发现 skill、`/skills use <name>` 激活 skill、`/skills clear` 清空 skill，会话内可见当前 active skill
213. skill prompt injection 已接入 provider 主流程：当 active skill 存在时，首条发给模型的 user message 会自动注入 skill 名称、约束和工作流提示
214. allowedTools 约束已接入主流程：active skill 会拦截不允许的本地工具调用，也会阻断需要超出技能工具集的 `/orchestrate` 执行；这让 skill 不只是提示词，而是真正影响执行边界
215. 新增回归测试：覆盖 skill 列表/激活、provider prompt 注入、读型 skill 对 `/write` 的拦截，以及 read-only skill 对写型 orchestration 的阻断；全量校验再次通过，当前共 12 个测试文件、85 个测试
216. 开始补齐 `T2.7 Remaining Commands`：`/doctor`、`/review`、`/summary`、`/export`、`/reload-plugins`、`/debug-tool-call` 已全部接入 `QueryEngine`
217. 新命令都复用了现有核心模块：`/doctor` 复用 `runDoctor()`，`/review` 复用 Planner/Executor/Reflector 编排链，`/summary` 复用 transcript/compact 摘要逻辑，`/export` 复用会话 transcript 导出，`/debug-tool-call` 复用本地工具解析和权限检查
218. `/export` 当前支持默认导出或自定义相对路径导出，并会自动创建目标目录；导出内容为 markdown transcript，保持最小可读性
219. `/review` 当前走 review lane：以 `review <goal>` 进入现有编排链，并显式展示 `skill: review`、`action-logs` 和 `reflector-decision`；这让 review 命令不只是切 skill，而是真正复用可验证执行路径
220. 新增回归测试：覆盖 `/summary`、`/debug-tool-call`、`/export`、`/reload-plugins`、`/review`、`/doctor`；全量校验再次通过，当前共 12 个测试文件、86 个测试
221. 完成 `T2.6 MCP` 的最小闭环：新增 `src/mcp/service.ts`，提供本地 in-process `workspace-mcp` server，可列出 server、resources、tools，支持 `read resource` 和 `call tool`
222. 当前 `workspace-mcp` 暴露 3 个资源能力：`workspace://summary`、`workspace://package-json`、`workspace://progress-log`；暴露 2 个工具：`search-files` 和 `read-snippet`
223. `/mcp` 命令已接入 `QueryEngine`，当前支持：`/mcp`、`/mcp resources <server>`、`/mcp tools <server>`、`/mcp read <server> <resource>`、`/mcp call <server> <tool> <input>`
224. MCP 读资源和工具调用已受权限模型约束：`mcp-read` 走低风险通道，`mcp-call` 走中风险通道；在 `plan/default` 下，MCP tool call 会被明确拦住，在 `auto/acceptEdits` 下可执行
225. 新增回归测试：`test/mcp-service.test.ts` 覆盖 server/resource/tool 能力；`test/query-engine.test.ts` 覆盖 `/mcp` 命令链路和权限约束；全量校验再次通过，当前共 13 个测试文件、89 个测试
226. TODO：当用户输入“某个文件路径 + 读取/看看/总结”这类自然语言请求时，自动路由到 `/read`，避免普通对话路径吞掉本地文件读取意图
227. Phase 2 收尾项开始补齐：新增 `test/orchestration-playback.test.ts`，用 10 条真实任务样例回放 Planner / Executor / Reflector
228. 当前 10 条回放样例覆盖 4 类结果：`complete`、`approval-required`、`replan`、`escalated`；同时覆盖 `query/analyze/create/fix/task` 五类 intent
229. 回放样例里既有读类完成路径，也有写入审批路径、缺 provider 的重规划路径，以及 repeated failure 的升级路径；这让 Phase 2 不再只靠零散单测证明，而是有一组完整任务样例
230. 新增 `docs/PHASE2_PLAYBACKS.md`，把 10 条样例、预期 intent、预期决策和验证目的整理成一页交付文档
231. 当前 Phase 2 的“Planner / Executor / Reflector 集成样例收口”已经具备：一组可执行回放测试 + 一页样例矩阵文档；后续若继续扩样例，只需要在 playback suite 里追加场景即可
232. 全量校验再次通过：当前共 14 个测试文件、99 个测试
233. 再补 QueryEngine 级端到端样例：新增 `test/query-engine-e2e.test.ts`，通过 `IngressGateway + QueryEngine` 覆盖入口级真实链路
234. 当前 E2E 样例覆盖 3 条主链：`review + MCP + shared session`、`orchestration approval + export`、`skill prompt injection + provider lane + command lane coexistence`
235. 新增 `docs/PHASE2_DELIVERY.md`，明确给出当前 `Phase 2` 的交付结论：在当前 MVP 边界下可正式收口，并列出已知延期项
236. 为保证回放类与 E2E 类测试稳定，相关样例测试显式固定到 fallback LSP 路径，避免真实 multilspy bridge 启动耗时带来的 5 秒默认测试超时噪音；真实 LSP 仍由 `lsp-bridge` / `lsp-service` 专项测试覆盖
237. 当前 `Phase 2` 已同时具备：能力实现、命令入口、SDK/HTTP、MCP、Skills、10 条 playback、3 条 E2E 样例，以及对应交付文档，可作为正式转入下一阶段的依据
238. 全量校验再次通过：当前共 15 个测试文件、102 个测试

### Verification Snapshot
1. `npm run lint` 通过
2. `npm run typecheck` 通过
3. 定向验证通过：`test/lsp-service.test.ts` 在默认模式下 7/7 通过；显式开启 `CODECLAW_ENABLE_REAL_LSP=1` 后，“真实 backend 命中”和“桥接失败回退”两条路径也通过
4. 实机验证通过：最小 TS 工作区下，`scripts/lsp_multilspy_bridge.py` 已能返回真实 `degraded: false` 的 symbol / definition / references 结果
5. 实机验证通过：当前 `codeclaw` 仓库下，真实 multilspy `definition createQueryEngine` 与 `references createQueryEngine` 已返回 `degraded: false` 结果
6. 实机验证通过：CLI plain REPL 主流程下，未设置 `CODECLAW_ENABLE_REAL_LSP` 时 `/definition createQueryEngine` 默认显示 `LSPTool backend: multilspy`
7. 当前全量验证通过：`lint / typecheck / build / test` 均通过，测试总数 74
8. 当前定向验证通过：`test/lsp-service.ts`、`test/local-tools.ts`、`test/query-engine.ts` 均通过；实机 `scripts/lsp_multilspy_bridge.py --kind definition --query createQueryEngine` 返回真实 `degraded: false` 结果
9. 当前最小编排主线已验证通过：`test/orchestration.test.ts` 与 `test/query-engine.test.ts` 中的 `/plan`、`/orchestrate`、重复 gap 升级断言全部通过
10. 当前最小执行型 orchestration 已验证通过：`/orchestrate` 不再只是跑 checks，还会真实执行 `inspect-file / inspect-symbol / run-package-script(typecheck)` 并回传 `action-logs`
11. 当前读类增强已验证通过：`/orchestrate` 已会真实执行 `inspect-references`，并在输出中显式展示 `write-lane` 评估与更细粒度的 `action-logs`
12. 当前 orchestration 审批语义已验证通过：`/orchestrate create ...` 会返回 `reflector-decision: approval-required`，`/approvals` 会列出 orchestration 审批，`/approve` / `/deny` 会触发对应的 Reflector 分支
13. 当前 approved 后的真实执行链已验证通过：orchestration `/approve` 不再只返回 follow-up goal，而是会真实触发本地 `write/replace` 工具并修改目标文件
14. 当前 approved 后的执行内容已验证升级：新文件会得到语言感知 scaffold，existing 文件会得到更像真实 patch 的确定性导出/片段，而不再只是 placeholder 文本
15. 当前 replace 锚点已验证升级：在 TS/JS/Python 这类文件里，会优先把 patch 插到最后一个函数/类代码块后，而不是简单贴在单行声明后
16. 当前 approved replace 的底层落盘策略也已验证升级：先在内存里构造完整新文件，再用 `/write` 落盘；这减少了对运行时字符串 replace 的依赖
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
27. Phase 1 交付说明文档已补齐，当前可按 `docs/PHASE1_DELIVERY.md` 作为收口说明
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
7. 当前 approved 后的执行链已从 placeholder 升级为语言感知 scaffold/patch，并增加了更安全的块级和导出区锚点；但仍然不是通用 AST 级 edit 语义，也还没有接真正的实现生成
8. 当前已无已知的测试级阻塞问题；后续主要是继续扩展 `Planner / Executor / Reflector` 的动作集合、审批语义和反思能力，并继续优化 LSP 结果质量

### Phase 3.5 Progress
1. 已新增 `src/channels/wechat/adapter.ts`、`src/channels/wechat/formatter.ts`、`src/channels/wechat/types.ts`，形成最小可测的微信适配层
2. 微信入口现在会把 iLink 风格消息映射成 `IngressMessage`，并在 `channelSpecific` 中保留 `chatId / chatType / senderId / contextToken`
3. 微信会话上下文采用 `wechat:<chatType>:<chatId>:<senderId>` 作用域，避免同一用户跨群聊/私聊串会话
4. 微信 adapter 内部已实现按 `contextToken/sessionId` 复用 runtime，可真实做到“首次建会话，后续继续同一会话”
5. `QueryEngine` 已补充 `getChannelSnapshot()`，渠道侧现在可以复用同一份消息、审批和运行态快照生成卡片
6. 已支持 Markdown 卡片输出：普通消息回复卡、审批通知卡、恢复会话卡
7. 已支持审批通知/恢复：待审批时可生成包含 `detail / reason / queue` 和 `/approve` `/deny` 提示的微信卡片
8. 新增 `test/wechat-adapter.test.ts`，覆盖 context mapping、session continue、markdown card、approval notify / resume
9. 已新增 `src/channels/wechat/handler.ts`，提供最小 webhook 边界：`GET /health`、`POST /v1/wechat/events`
10. webhook 事件当前支持 `message`、`resume`、`approval-notify` 三类输入，可直接产出微信 Markdown 卡片
11. 已新增 `test/wechat-handler.test.ts`，覆盖批量 webhook 事件、空消息丢弃、handler health、bearer auth
12. 已新增 `src/channels/wechat/ilink.ts`，支持把 raw iLink 风格 payload 归一化为统一 `WechatWebhookRequest`
13. 当前 `/v1/wechat/events` 已同时兼容“标准化 webhook request”和“raw iLink 风格 payload”两种输入
14. 已支持 approval sweep：adapter 可一次收集所有活跃 session 的待审批卡片，handler 提供 `POST /v1/wechat/approvals/sweep`
15. `test/wechat-adapter.test.ts` 已增加 approval sweep 覆盖；`test/wechat-handler.test.ts` 已增加 raw payload normalize 与 approval sweep 覆盖
16. 已新增 `src/channels/wechat/service.ts`，形成独立微信服务入口；CLI 现在支持 `codeclaw wechat` 启动本地微信 adapter webhook
17. 已新增 `docs/WECHAT_BOT.md`，补齐启动方式、接口、raw iLink payload 示例和当前边界
18. 已新增 `test/wechat-e2e.test.ts`，覆盖“微信消息 -> orchestration approval -> resume -> /approve -> 真正写文件”的端到端链路
19. 当前 T3.5 验收口径已满足：
    - 微信消息能创建和继续 session
    - 审批状态机与 CLI 一致
    - approval notify / resume 已通过微信卡片闭环验证
20. 已新增 `src/channels/wechat/token.ts`、`src/channels/wechat/worker.ts`，真实 iLink worker 现在支持 `token_file -> pollUpdates -> sendMessage`
21. CLI 现在支持 `codeclaw wechat --worker`，会从 `gateway.bots.ilinkWechat.tokenFile` 或 `CODECLAW_ILINK_WECHAT_TOKEN_FILE` 读取 token 文件
22. 已新增 `test/wechat-worker.test.ts`，覆盖 token_file 读取和真实轮询回发链路
23. 当前 T3.5 已完整收口：webhook 入口、raw payload normalize、approval sweep、独立 service、真实轮询 worker、端到端链路均已具备
24. 当前全量验证通过：`npm run lint`、`npm run typecheck`、`npm run test`、`bun run build`
25. 当前测试总数更新为：`20` 个测试文件，`115` 个测试，全部通过

### Next Session Priorities
1. T3.5 已完成，若继续深化可考虑接真实 iLink API 字段细节和更强的发送失败重试
2. 为微信卡片补更细的审批恢复路径，尤其是 orchestration approval 的专门文案和 resume 提示
3. 开始 Phase 3 其他主线，优先考虑插件系统或 RAG，而不是回头扩张 Phase 1/2 范围

### T3.5 Protocol Alignment Update
1. 已按腾讯云 iLink 微信 Bot 协议重写微信协议层：`src/channels/wechat/worker.ts` 不再使用假设的 `GET /pollUpdates` 与 `POST /sendMessage`，而是改为真实 `POST ilink/bot/getupdates` 与 `POST ilink/bot/sendmessage`
2. iLink 请求头现已对齐真实协议：统一附带 `AuthorizationType: ilink_bot_token`、随机 `X-WECHAT-UIN` 与 `Authorization: Bearer <bot_token>`
3. `src/channels/wechat/worker.ts` 已补 `get_updates_buf` 长轮询游标；35 秒超时已作为正常空轮询处理，而不是错误退出
4. `sendmessage` payload 已切到真实 `msg` 结构：包含 `from_user_id`、`to_user_id`、`client_id`、`message_type`、`message_state`、`item_list` 与 `context_token`
5. `src/channels/wechat/token.ts` 已扩成真实凭证模型，当前会保存并读取：`bot_token`、`baseurl`、`ilink_bot_id`、`ilink_user_id`
6. 已新增 `src/channels/wechat/auth.ts` 与 `src/channels/wechat/loginManager.ts`，支持最小扫码登录状态机：`get_bot_qrcode -> get_qrcode_status -> 保存 token_file`
7. `QueryEngine` 已新增 `/wechat` 与 `/wechat status`；在 CLI 里输入 `/wechat` 即可拉起二维码登录流程
8. `src/channels/wechat/ilink.ts` 已按真实 `msgs/item_list/context_token` 协议解析入站消息，不再只依赖旧的简化 `message.content.text`
9. `docs/WECHAT_BOT.md` 已按新协议重写，补充了 `/wechat` 扫码登录、真实 iLink 路径、真实 token_file 结构和 worker 运行方式
10. 当前 T3.5 协议修正已收口：`QueryEngine` 的 `/wechat` 命令测试已补齐，专项与全量校验重新收绿
11. 已修复 CLI `/wechat` 默认回退逻辑：即使老的 `config.yaml` 没有显式写 `gateway.bots.ilinkWechat.tokenFile`，CLI 也会回退到项目默认 token 路径 `~/.claude/wechat-ibot/default.json`，不再错误提示“未配置”
12. 已补终端二维码显示：新增 `qrcode` 依赖并在 `/wechat` 输出里渲染 `terminal-qr`，不再只打印 `qrcode: ...` 文本；同时把默认 iLink 地址统一成 `https://ilinkai.weixin.qq.com`
13. 已修正终端二维码的真实扫码内容：`terminal-qr` 现在优先编码 `qrcode-image` URL，而不是内部 `qrcode` token；这解决了“看得到二维码但微信扫不出来”的问题
14. 已新增 `/wechat refresh`：二维码有效期由 iLink 服务端控制，客户端无法真正延长 TTL，因此增加了显式换码命令，便于在快过期时立即刷新出一张新二维码
15. 已支持“微信加入当前 session”：在当前 CLI 会话执行 `/wechat` 时，会把微信 adapter 绑定到当前 `queryEngine` runtime；后续微信消息将复用这个 session，而不是总是新建独立 session
16. 已支持登录确认后自动起 worker：`IlinkWechatLoginManager` 新增 `onConfirmed` 钩子，CLI 在扫码确认后会自动启动同进程微信 worker，不再要求手动再开一个 `wechat --worker`
17. 已收紧微信 session 绑定优先级：显式执行 `/wechat` 绑定当前 session 后，adapter 会优先使用共享 runtime，不再被旧 `context_token` 抢回旧 session
18. 已回收旧的同 userKey 微信 runtime：重新绑定当前 session 时，会清理旧 userKey 对应的 runtime 映射，避免“微信同时挂在两个 session 上”的现象
19. 已补 QueryEngine 订阅能力：CLI 现在会订阅同一 session 的外部写入，微信消息进入当前 session 后，CLI transcript 会同步更新，不再出现“同 session 但界面不互通”的假象
20. 已优化微信 worker 响应节奏：收到消息后立即继续下一轮 `getupdates`，空闲时本地轮询间隔默认从 `1000ms` 降到 `100ms`
21. 当前全量验证重新收绿：`npm run lint`、`npm run typecheck`、`npm run test`、`bun run build` 全部通过
22. 当前测试总数更新为：`20` 个测试文件，`118` 个测试，全部通过
23. 已修复“微信/CLI 同 session 但输入信息不互通”：`QueryEngine` 现在在 user turn 入栈时也会通知订阅者，CLI 可看到微信输入；wechat adapter 也能为非微信来源的新 assistant turn 生成会话同步卡片
24. 已完成开源前最小清理：删除临时文件 `a.ts`，并将 `docs/`、`PROGRESS_LOG.md`、`test/lsp-bridge.test.ts` 中暴露本机绝对路径的内容改为相对路径或运行时路径
25. 开源前全量校验已重新通过：`npm run lint`、`npm run typecheck`、`npm run test`、`bun run build`
26. 当前测试总数更新为：`20` 个测试文件，`120` 个测试，全部通过
27. 已新增开源首页 `README.md`，补齐项目简介、能力边界、快速启动、LSP、HTTP API 与 WeChat Bot 入口说明
28. 已新增首版发布说明 `docs/RELEASE_v0.5.0.md`，整理 `v0.5.0` 的交付范围、验证快照与已知边界
24. 微信卡片已增强为“最新输入 + 最新回复”，并加入微信软长度限制裁剪，减少超长文本发不全的问题
25. 微信 worker 已进一步优化：除了收到入站消息立即继续下一轮外，也会在轮询周期内主动 flush 会话同步卡片，把 CLI 侧的新消息推回微信
26. 本轮已通过定向验证：`npm run lint`、`npm run typecheck`、`./node_modules/.bin/vitest run test/wechat-adapter.test.ts test/wechat-worker.test.ts test/wechat-e2e.test.ts test/query-engine.test.ts`、`bun run build`
27. 已修复 wechat auto-worker 因长轮询超时直接退出的问题：`TimeoutError` 现在按正常空轮询处理，`LONG_POLL_TIMEOUT_MS` 已恢复到 `35_000`

## 📌 SESSION HANDOFF STATUS
### Current Work: T3.5 微信协议层已对齐真实 iLink 协议，并已完成测试与文档收口
### Background Tasks: 无
### Next Session Priorities:
1. 用真实 iLink 环境验证 `/wechat` 扫码登录与 `codeclaw wechat --worker` 的线上链路
2. 若真实环境字段存在差异，优先修 `auth/worker/ilink parser` 的协议细节
3. 全量稳定后继续 Phase 3 其他主线
### Resume Checklist:
1. `node dist/cli.js --plain`
2. 在 CLI 里执行 `/wechat`
3. 登录成功后执行 `node dist/cli.js wechat --worker`
4. 如需回归验证：`npm run lint && npm run typecheck && npm run test && bun run build`
