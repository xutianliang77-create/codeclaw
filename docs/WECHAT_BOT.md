# WeChat Bot

`T3.5` 现在分成两条接入路径：

1. webhook 模式：外部 Bot 把消息转发进 CodeClaw
2. iLink worker 模式：CodeClaw 自己扫码登录，并轮询 iLink 接口

CLI 内也新增了 `/wechat` 命令：

- `/wechat`：发起扫码登录，并把微信通道绑定到当前 CLI session
- `/wechat status`：刷新并查看当前登录状态
- `/wechat refresh`：重新生成一张新的二维码

## 配置

`config.yaml` 里的最小配置：

```yaml
gateway:
  bots:
    ilinkWechat:
      enabled: true
      tokenFile: "~/.codeclaw/wechat-ibot/default.json"
      baseUrl: "https://ilinkai.weixin.qq.com"
      pollIntervalMs: 1000
```

环境变量可覆盖：

```bash
CODECLAW_ILINK_WECHAT_TOKEN_FILE=~/.codeclaw/wechat-ibot/default.json
CODECLAW_ILINK_WECHAT_BASE_URL=https://ilinkai.weixin.qq.com
```

## 扫码登录

在 CLI 里输入：

```text
/wechat
```

CodeClaw 会：

1. 调 `GET ilink/bot/get_bot_qrcode?bot_type=3`
2. 返回二维码状态
3. 后台轮询 `GET ilink/bot/get_qrcode_status?qrcode=...`
4. 登录确认后把凭证写入 `tokenFile`
5. 自动在当前 CLI 进程里启动微信 worker

说明：

- 终端里显示的 `terminal-qr` 现在会优先编码 `qrcode-image` 的真实扫码 URL，而不是内部 `qrcode` token
- 二维码有效期由 iLink 服务端控制，客户端不能真正延长；如果快过期，可直接执行 `/wechat refresh`
- 在当前 CLI session 里执行 `/wechat`，会把微信通道绑定到这个 session；后续来自微信的消息会复用这个会话上下文
- 如果你重启了 CLI，只需要在新的 session 里再执行一次 `/wechat`，就会重新绑定到新的当前 session
- 当前 CLI 已订阅同一 `QueryEngine` 的外部更新；微信写进这个 session 的消息和回复会同步反映到 CLI transcript 中

然后可用：

```text
/wechat status
```

查看是否已变成 `phase: confirmed`。

## token_file

扫码确认后，`tokenFile` 会保存真实 iLink 凭证：

```json
{
  "bot_token": "...",
  "baseurl": "https://ilinkai.weixin.qq.com",
  "ilink_bot_id": "...",
  "ilink_user_id": "...",
  "qrcode": "..."
}
```

worker 和后续恢复都从这里读取。

## 启动方式

### 1. webhook 模式

```bash
node dist/cli.js wechat --port 3100
```

可选 bearer auth：

```bash
CODECLAW_WECHAT_TOKEN=secret-token node dist/cli.js wechat --port 3100
```

### 2. iLink worker 模式

也可以手动启动：

```bash
node dist/cli.js wechat --worker
```

worker 会：

1. 读取 `tokenFile`
2. `POST ilink/bot/getupdates`
3. 把收到的微信消息送进 CodeClaw
4. 把返回卡片通过 `POST ilink/bot/sendmessage` 回发微信

不过在 CLI 里通过 `/wechat` 扫码确认后，worker 默认已经会自动启动；`codeclaw wechat --worker` 更适合单独跑独立 worker 进程时使用。

轮询说明：

- iLink `getupdates` 本身是长轮询
- 当前 worker 在“收到消息”后会立刻继续下一轮
- 只有空闲轮询时才会等待本地 `pollIntervalMs`
- 默认空闲间隔已降到 `100ms`

## iLink 协议

### 鉴权头

每次请求都会带：

```http
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: <随机base64>
Authorization: Bearer <bot_token>
```

### getupdates

```http
POST ilink/bot/getupdates
Content-Type: application/json
```

请求体：

```json
{
  "get_updates_buf": "..."
}
```

说明：

- `get_updates_buf` 是长轮询游标
- 35 秒超时视为正常空轮询，不算错误

### sendmessage

```http
POST ilink/bot/sendmessage
Content-Type: application/json
```

请求体：

```json
{
  "msg": {
    "from_user_id": "...",
    "to_user_id": "...",
    "client_id": "...",
    "message_type": 2,
    "message_state": 2,
    "item_list": [
      {
        "type": 1,
        "text_item": {
          "text": "# CodeClaw 微信 Bot\\n..."
        }
      }
    ],
    "context_token": "session-..."
  }
}
```

## webhook 接口

### Health

```http
GET /health
```

### WeChat Events

```http
POST /v1/wechat/events
```

当前支持：

1. 标准化 `WechatWebhookRequest`
2. iLink `msgs` 风格 payload

### Approval Sweep

```http
POST /v1/wechat/approvals/sweep
```

用于批量拉取所有活跃 session 的待审批卡片。

## 入站消息映射

真实 iLink 入站消息会从 `msgs` 里解析：

- 只处理 `message_type === 1`
- 从 `item_list[type=1].text_item.text` 提取文本
- 复用 `context_token`

映射后的内部会话作用域仍然是：

```text
wechat:<chatType>:<chatId>:<senderId>
```

## 当前能力

1. 微信消息复用同一套 `session / approval / orchestration` 模型
2. 支持 markdown 卡片输出
3. 支持 approval notify / resume
4. 支持 `/approve`、`/deny` 继续审批流
5. 支持 `/wechat` 扫码登录
6. 支持 `codeclaw wechat --worker` 真实 iLink 轮询

## 当前边界

1. 目前扫码登录走的是最小状态机：拉二维码、轮询状态、落盘凭证
2. 当前默认把 iLink 入站消息按 direct chat 处理，群聊/更复杂会话语义后续可继续细化
3. 微信卡片当前仍以 markdown 文本为主，还没做更复杂的富卡片结构
