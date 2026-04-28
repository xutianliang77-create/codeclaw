# 接入 Dremio MCP（OSS 自托管）

把 Dremio OSS 的查询能力接入 codeclaw，让 LLM 通过 MCP 工具直接对 Dremio 跑 SQL、查表 schema、看血缘。

> 适用：自部署的 Dremio OSS（开源版）。Dremio Cloud 走 OAuth 路径，本文不覆盖（codeclaw v0.8.x 暂未实现 HTTP+OAuth transport，待 v0.9）。

---

## 全链路示意

```
codeclaw CLI（Mac）
   ↓ stdio JSON-RPC
dremio-mcp-server（本地 Python 进程）
   ↓ HTTP(S) + Bearer token
Dremio OSS Daemon（docker / 物理机）
```

---

## 前置环境

| 必需 | 版本 / 说明 |
|---|---|
| Docker（任一） | Docker Desktop 4.34+ / Colima / 直接装 dremio 物理机 |
| uv（Python 工具管理器） | `brew install uv` |
| Node 22+ | codeclaw 自身要求 |
| codeclaw | v0.8.0+（含 MCP stdio 支持 + stderr 限速） |

### Mac 代理用户必读

如果你在 Mac 上挂了系统代理（Clash / Surge / SOCKS），**必须把 `localhost` 和 `127.0.0.1` 加入 bypass**，否则 dremio-mcp-server 调本地 OSS 会被代理截胡返回 502。

```bash
# 永久（添加到 ~/.zshrc）
echo 'export NO_PROXY="localhost,127.0.0.1,*.local"' >> ~/.zshrc
echo 'export no_proxy="localhost,127.0.0.1,*.local"' >> ~/.zshrc
exec zsh
```

或者去 Clash / Surge 客户端里把 `localhost`、`127.0.0.1` 加入直连规则（推荐 — 影响面更广）。

---

## 步骤 1：起 Dremio OSS

### 用 Docker（最快）

```bash
docker run -d --name dremio-oss \
  -p 9047:9047 -p 31010:31010 -p 32010:32010 \
  --memory 4g \
  dremio/dremio-oss:latest

# 等约 60-90 秒启动
docker logs -f dremio-oss
# 看到 "Dremio Daemon Started" 后 Ctrl+C 退出 logs

# 浏览器打开
open http://localhost:9047
```

第一次访问会让你**建 admin 账号**（first user wizard）。建完后牢记 username + password。

### Docker 残留 credsStore 排错

如果你之前装过 Docker Desktop 又卸载了，`docker run` 可能报：

```
docker: error getting credentials - err: exec: "docker-credential-desktop": executable file not found
```

修法：

```bash
# 看 ~/.docker/config.json 里的 credsStore 行
cat ~/.docker/config.json
# 删掉 credsStore 行
sed -i.bak '/credsStore/d' ~/.docker/config.json
# 验证
docker run hello-world
```

---

## 步骤 2：拿到 Dremio API Token

Dremio OSS 26.x 默认**不开启 PAT**（Personal Access Token）。两条路径：

### 路径 A：用 session token（最快，24 小时有效）

`/apiv2/login` 用账号密码换一个临时 token，可当 PAT 用 24h：

```bash
# 把 username 和 password 换成你建 admin 时填的
curl --noproxy localhost,127.0.0.1 -X POST http://localhost:9047/apiv2/login \
  -H "Content-Type: application/json" \
  -d '{"userName":"admin","password":"你的密码"}' | python3 -m json.tool
```

输出会含 `"token": "xxxxx..."` — 复制 token 字符串备用。

⚠️ **24 小时后过期**。过期后 dremio-mcp 会报 401，重新 curl 拿新 token + 改 yaml 即可。

### 路径 B：启用真正的 PAT（长期方案）

适合长期使用。需要管理员权限：

1. 浏览器登录 OSS
2. 右上头像 → **Settings** → 左侧 **Cluster Settings**
3. 找 `support.users.tokens.enabled`，设为 `true`
4. 保存后，回到 **Account Settings** → 左侧多出 **Personal Access Tokens** tab
5. 点 **Create Token**，名字、过期时间（最长 90 天）随便填，**复制 token**

PAT 字符串可以替代 session token 用同样的位置（dremio-mcp config 的 `pat` 字段）。

---

## 步骤 3：装 dremio-mcp-server

dremio-mcp 没发布到 PyPI，从 git 直接装：

```bash
uv tool install git+https://github.com/dremio/dremio-mcp.git
```

装完后可执行命令在 `~/.local/bin/dremio-mcp-server`。如果 PATH 没含 `~/.local/bin`：

```bash
uv tool update-shell
exec zsh

# 验证
which dremio-mcp-server
dremio-mcp-server --help
```

如果 `which` 没找到，直接用绝对路径 `/Users/<your-user>/.local/bin/dremio-mcp-server` — 后面的 mcp.json 反正要绝对路径。

---

## 步骤 4：配 dremio-mcp-server

```bash
export DREMIO_URI=http://localhost:9047
export DREMIO_PAT=粘贴你刚才的 token

/Users/$(whoami)/.local/bin/dremio-mcp-server config create dremioai \
  --uri "$DREMIO_URI" \
  --pat "$DREMIO_PAT" \
  -m FOR_DATA_PATTERNS
```

`-m FOR_DATA_PATTERNS` 是 server 模式（数据探索）。其他选项：
- `FOR_SELF`：集群自查（jobs / engines）
- `FOR_PROMETHEUS`：指标查询（需另外配 Prometheus）

写完后验证：

```bash
cat ~/.config/dremioai/config.yaml
```

应该看到：

```yaml
dremio:
  uri: http://localhost:9047
  pat: <your-token>
tools:
  server_mode: FOR_DATA_PATTERNS
```

---

## 步骤 5：配 codeclaw

```bash
mkdir -p ~/.codeclaw
```

写 `~/.codeclaw/mcp.json`（**注意 `NO_PROXY` env 必须有**，否则 dremio-mcp 调 localhost OSS 会被代理拦）：

```json
{
  "servers": {
    "dremio": {
      "command": "/Users/YOUR_USERNAME/.local/bin/dremio-mcp-server",
      "args": ["run"],
      "env": {
        "NO_PROXY": "localhost,127.0.0.1",
        "no_proxy": "localhost,127.0.0.1"
      }
    }
  }
}
```

把 `YOUR_USERNAME` 替换成你的实际用户名（`whoami` 输出）。

> 不要用 nano 拷贝粘贴写这个文件 — 容易触发终端断行问题。直接用 echo 一行写更稳：
>
> ```bash
> echo '{"servers":{"dremio":{"command":"/Users/'"$(whoami)"'/.local/bin/dremio-mcp-server","args":["run"],"env":{"NO_PROXY":"localhost,127.0.0.1","no_proxy":"localhost,127.0.0.1"}}}}' > ~/.codeclaw/mcp.json
> cat ~/.codeclaw/mcp.json
> ```

---

## 步骤 6：验证

启动 codeclaw：

```bash
cd /path/to/codeclaw
node dist/cli.js
```

进入 CLI 后**先列工具**：

```
/mcp tools dremio
```

应该列出 7 个工具：

- `mcp__dremio__RunSqlQuery`
- `mcp__dremio__GetUsefulSystemTableNames`
- `mcp__dremio__GetSchemaOfTable`
- `mcp__dremio__GetTableOrViewLineage`
- `mcp__dremio__DiscoverDynamicTools`
- `mcp__dremio__CallDynamicTool`
- `mcp__dremio__GetDescriptionOfTableOrSchema`

**直接调一次**（不经过 LLM 推理）：

```
/mcp call dremio GetUsefulSystemTableNames {}
```

应该返回 6 张系统表（INFORMATION_SCHEMA.TABLES、sys.project.jobs_recent 等）+ 描述。

**自然语言测**：

```
看 sys.project.jobs_recent 的表结构
```

LLM 应该自动调 `mcp__dremio__GetSchemaOfTable`。如果 LLM 没认出工具直接编答案，模型 native tool_use 能力弱，明确说"用 dremio 工具"即可。

---

## 排错速查

| 症状 | 原因 | 修法 |
|---|---|---|
| `unknown MCP server: dremio` | `~/.codeclaw/mcp.json` 不存在 / JSON 语法错 | `cat ~/.codeclaw/mcp.json` + `python3 -m json.tool ~/.codeclaw/mcp.json` 验证 |
| `/apiv2/login` 返 502 Bad Gateway | Mac 代理把 localhost 也吞了 | curl 加 `--noproxy localhost,127.0.0.1` |
| `dremio-mcp-server` 启动后立刻退 | PAT 401 / uri 不通 | 单独跑 `NO_PROXY=localhost,127.0.0.1 dremio-mcp-server run` 看错误 |
| 调用工具时报 `terminated` / `connection closed` | session token 过 24h 过期 | curl `/apiv2/login` 拿新 token + 改 yaml |
| Terminal.app 启动 codeclaw 后用一会就崩 | macOS 26 beta NSEvent UAF bug | 换 Ghostty / iTerm2，**不要再用 Terminal.app** |
| LLM 答查询时不调 MCP 工具凭空编答案 | 模型 native tool_use 能力弱 | 在 prompt 里明确说 "用 dremio 工具"；或换更强的 reasoning 模型 |

---

## 下一步可选

- **加业务数据**：UI → Add Source → NAS（local file）/ Postgres / S3 等，让 LLM 跑真实业务 SQL
- **启 PAT** 替代 24h session token，免去每天 curl 拿 token 的麻烦
- **多 server 配置**：在 `mcp.json` 加多个 server（同一文件内 `servers.<name>`），codeclaw 会自动并发拉起

---

## 参考

- dremio-mcp: https://github.com/dremio/dremio-mcp
- Dremio OSS: https://github.com/dremio/dremio-oss
- MCP 协议: https://spec.modelcontextprotocol.io/
- codeclaw MCP 客户端：`src/mcp/client.ts`、`src/mcp/manager.ts`、`src/mcp/bridge.ts`
