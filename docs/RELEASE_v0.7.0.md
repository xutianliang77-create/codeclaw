# CodeClaw v0.7.0

**First-Run Automation + Bilingual UI** — 把"装机到能用"从 11 步缩到 3 步，所有用户面向文案中英双语；顺手扫掉 v0.6 真测撞到的 9 个 UX bug。

## Highlights

### First-Run Automation epic（FRX · #144-148）

新机器从 0 到能用的步骤：

```bash
# v0.6.0：11 步手动
git clone <repo> && cd codeclaw && npm install
cd web-react && npm install && npm run build && cd ..
node scripts/build.mjs
chmod +x dist/cli.js && npm link
npm rebuild better-sqlite3       # 跨平台拷时
codeclaw setup
手编 ~/.codeclaw/providers.json 加 maxTokens / contextWindow
export CODECLAW_NATIVE_TOOLS=true
export CODECLAW_WEB_TOKEN=...
node dist/cli.js web --port=7180

# v0.7.0：3 步开箱即用
git clone <repo> && cd codeclaw && npm install   # 自动装两边 deps + build 前端 + build 后端
codeclaw setup                                     # 自动探测 LM Studio / Ollama / API key + 生成 token
codeclaw                                            # CLI + Web 双开
```

#### Phase 1 · 基础设施（5 项）

- **native tools 默认开启**：env `CODECLAW_NATIVE_TOOLS` 不再需手动 export；`=false` 显式关
- **npm install 自动装 web-react deps**：postinstall 钩子（`scripts/post-install.mjs`）首次运行自动装齐两套 deps + 触发前端 build；`CODECLAW_SKIP_WEB_BUILD=true` 显式跳
- **better-sqlite3 跨平台自检**：CLI 启动时探测 `mach-o file` / `invalid ELF` 错误，给出明确 `npm rebuild` 修复指引（不自动跑，避免误动 node_modules）
- **postinstall + 启动 dist 防御**：检测 `dist/public-react/index.html` 缺失给清晰提示
- **Web token 自动生成 + 持久化**：首次启动 `codeclaw web` 自动生成 32-hex token 写到 `~/.codeclaw/web-auth.json`（mode 0600）；env `CODECLAW_WEB_TOKEN` 仍兼容（CI 优先）

#### Phase 2 · setup wizard 增强（5 项）

- **补 maxTokens / contextWindow 字段**：ProviderConfigApp 终于把这两个字段暴露成可编辑菜单（含正整数校验）；用户不再需手编 JSON
- **Provider 自动探测**：HTTP probe `localhost:1234` (LM Studio) / `localhost:11434` (Ollama) + 扫 env 中 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`，主菜单一键 "Auto-detect" 合并预填
- **集成 Web token 生成**：setup 流程 done 时自动 ensure token + echo 给用户；主菜单可重新生成
- **wizard 全文案双语化**：所有 ink 提示「英文 · 中文」并排

#### Phase 3 · 运行时整合（3 项）

- **CLI 默认同步起 Web**：`codeclaw` 单条命令同时拉起 CLI + Web；复用 CLI 的 queryEngine.cronManager（避免双 scheduler）；`--no-web` 退路；端口冲突 graceful skip；CLI exit 优雅关闭 web
- **Web 默认根 URL 升新版**：`/` 直接进新 7-tab React UI；旧 5-tab 降级到 `/legacy/`（保留 1-2 版兼容期）
- **cronHost 启动竞态修**：deep-reviewer S1 修复——cronHost 创建挪到 `startWebServer` 之前，消除"首屏切 Cron tab 闪现 Cron 不可用"窗口

### 真测撞到的 9 个 bug 修

| # | Bug | 优先级 | commit |
|---|---|---|---|
| 1 | **handleSubmit 双发** · Mac+ink 5 单次 Enter 触发 6 次提交（state 异步守卫失效）| **high** | `71a54dd` |
| 2 | **SubagentTree React #185** · selector ?? [] 死循环致整面板空白 | **high** | `2582ff3` |
| 3 | `/end` 在 CLI 模式下不写 memory digest（cli.tsx 没传 channel/userId）| medium | `ebfc67c` |
| 4 | `/skills` 协议三方不一致 + 接受 `list` / `off` / 直接 name 别名 | medium | `f779334` |
| 5 | `/cron add` 接受 `--name= --schedule= --kind= --payload=` flag 形式 | medium | `c831ff7` |
| 6 | slash 命令 typo `/skill` did-you-mean 提示（Levenshtein ≤ 2）| low | `8d52a95` |
| 7 | Cron run-now 改 toast + 自动定位 runs 历史（不再 window.alert）| medium | `e80b2ec` |
| 8 | graph callers 动态 import 解析（`const { X } = await import(...)`）| low | `4fb25c6` |
| 9 | cronHost 启动竞态（首屏 503 banner）| medium | `4e68e2d` |

### 全 UI 双语化（Phase 6）

- **App.tsx 运行时**：Header / StatusBar / ApprovalPanel / FooterHints / banner 系列「英文 · 中文」并排
- **36 个 slash 命令 summary**：SlashCommand 类型加 `summaryZh` 字段；`/help` 表格自动拼双语；`summary` 字段保持纯英文供 LLM 识别
- **Web UI**：tab tooltip / Header / Connect / Token 提示双语
- **护栏**：systemPrompt / tool schema / provider/client / memory digest prompt 一字未动；baseline tool-choice 通过率不降

## Numbers

| 项 | v0.6.0 | v0.7.0 |
|---|---|---|
| Slash 命令 | 36 | 36（全部加 `summaryZh`）|
| 主仓单测 | 1272 | 1314 |
| Web 通道端点 | 22 | 22（含 8 个 cron）|
| 装机步骤 | 11 | **3** |
| 手动 export 环境变量 | 2 | **0** |
| Bilingual 文案段 | ~10 | **~80**（36 命令 + CLI runtime + Web tab + setup 全流程）|

## Validation Snapshot

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 主仓 + web-react 双仓 0 错 |
| `npm run test`（主仓）| ✅ **1314/1314** |
| web-react vitest | ✅ 23/23 |
| baseline 24 题 stratified（refusal + snippet）| ✅ 75% overall（v3-100 73% 同档 +2pp 方差内）|
| LLM-facing 文件 diff | ✅ 0 行（systemPrompt / tool schema / provider/client / memory digest prompt 全未动）|

## Known Boundaries

- **subagent 真隔离**未做：父 engine 仍订阅 child 的 streaming 事件（context 工程留 v0.8）
- **prompt cache 标记**未做：每轮 system + tools schema 重传未走 ephemeral cache（成本痛点 → v0.8 ROI 最高）
- **多级 CODECLAW.md walk-up** 未做（v0.8）
- **工具结果智能截断**未做：`bash` / `grep` 长输出仍原样塞 messages（v0.8）
- helpDetail 双语未做（仅 summary 层），留 v0.7.x

## Migration Notes (v0.6.0 → v0.7.0)

**零迁移**——所有变更向后兼容：

- `CODECLAW_NATIVE_TOOLS` 默认 `true`：之前已设 `=true` 的脚本无影响；不依赖该 env 的环境也获得功能开启
- `CODECLAW_WEB_TOKEN` 仍优先于 `~/.codeclaw/web-auth.json`：CI / 容器场景 env 路径不变
- `/` 升级为新 React UI：旧版书签 `/legacy/` 仍可访问
- `npm install` 触发 postinstall：CI 环境（`CI=true`）自动跳过；不污染流水线
- 现有 `providers.json` / `cron.json` / `data.db` schema 完全不变

**旧 7 个 v0.7.0 项移除（清理无用 env / 文件）**：无（本版仅新增）

## Recommended Next Steps

### v0.7.x patches（可选小改）

- helpDetail 全双语（slash 命令的多行 Usage 块，36 × ~5 行 = ~180 段）
- 4 个 docs 文件（README / INSTALL / USAGE / SLASH_COMMANDS）双语
- `ui.locale` 字段加到 `~/.codeclaw/config.yaml`（`zh-en` / `zh` / `en` 单语切换）

### v0.8.0 Context Engineering epic（已规划）

5 条按 ROI 排序，预估 17-20 工时：

1. **Prompt cache 标记**（最高 ROI · 成本立省 60%+）：`src/provider/client.ts` Anthropic 路径加 `cache_control: ephemeral`
2. **system prompt 缓存复用**：避免每轮 rebuild 完整 system 字符串
3. **工具结果截断 + artifact ref**：read / bash / grep 长输出落 disk + 返句柄
4. **Subagent 真 isolation**：父 engine 不订阅 child streaming，只接 final summary
5. **多级 CODECLAW.md walk-up**：从 cwd 向上递归找，遇到 `.git` 停

详见 memory: `project_v080_context_engineering.md`。

## Acknowledgements

本 release 期间用户在 Mac 真机上跑了完整端到端测试，撞到 9 个 UX bug 全部已记并修复。

deep-reviewer 在 v0.6.0 收尾时审出 1 个 should-fix（cronHost 启动竞态 S1）已在 v0.7.0 P3.3 一并解决。
