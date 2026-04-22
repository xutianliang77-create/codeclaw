# CodeClaw HTTP API

CodeClaw 现在支持通过本地 gateway 暴露最小 HTTP API，底层复用同一套 `IngressGateway`、`SessionManager` 和 `QueryEngine`。

## 启动

```bash
codeclaw gateway
```

指定端口：

```bash
codeclaw gateway --port 3100
```

启用 bearer token：

```bash
CODECLAW_GATEWAY_TOKEN=secret-token codeclaw gateway --port 3100
```

默认监听地址：

```text
http://127.0.0.1:3000
```

## 认证

如果设置了 `CODECLAW_GATEWAY_TOKEN`，所有请求都必须带：

```http
Authorization: Bearer <token>
```

未配置 token 时，gateway 不做鉴权。

## 接口

### `GET /health`

健康检查。

响应示例：

```json
{
  "status": "ok",
  "service": "codeclaw-gateway"
}
```

### `POST /v1/messages`

发送一条消息到统一入口。

请求体：

```json
{
  "input": "help",
  "userId": "sdk-user",
  "sessionId": null,
  "stream": false
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `input` | `string` | 是 | 用户输入或命令 |
| `userId` | `string` | 否 | 调用方用户标识；默认 `http-user` |
| `sessionId` | `string \| null` | 否 | 显式指定会话；为空时走 gateway 的 session 映射 |
| `stream` | `boolean` | 否 | 为 `true` 时返回 SSE；也可通过 `Accept: text/event-stream` 触发 |

#### JSON 模式

请求：

```bash
curl -s http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -d '{"input":"help","userId":"sdk-user"}'
```

响应示例：

```json
{
  "sessionId": "session-xxxx",
  "traceId": "trace-xxxx",
  "channel": "http",
  "messages": [
    {
      "id": "msg-1",
      "role": "assistant",
      "text": "CodeClaw is ready. No provider is configured yet."
    },
    {
      "id": "msg-2",
      "role": "user",
      "text": "help"
    },
    {
      "id": "msg-3",
      "role": "assistant",
      "text": "Available commands: ..."
    }
  ],
  "pendingApproval": null
}
```

#### SSE 模式

请求：

```bash
curl -N http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"input":"doctor","userId":"sdk-user","stream":true}'
```

每条事件格式：

```text
data: {"sessionId":"...","traceId":"...","channel":"http","timestamp":...,"payload":{...}}
```

`payload` 对应当前的 `EngineEvent`，常见类型包括：

| `payload.type` | 说明 |
|---|---|
| `phase` | `planning / compacting / executing / completed / halted` |
| `message-start` | assistant 消息开始 |
| `message-delta` | 流式文本增量 |
| `message-complete` | assistant 消息结束 |
| `approval-request` | 请求审批 |
| `approval-cleared` | 审批已处理 |
| `tool-start` | 工具开始 |
| `tool-end` | 工具结束 |

### `POST /v1/interrupt`

中断当前或指定会话。

请求：

```bash
curl -s http://127.0.0.1:3000/v1/interrupt \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-xxxx"}'
```

响应示例：

```json
{
  "ok": true,
  "sessionId": "session-xxxx"
}
```

## 会话语义

HTTP API 复用和 CLI 相同的会话模型：

1. 入口消息先转换成 `IngressMessage`
2. `SessionManager` 维护 `channel:userId -> sessionId`
3. `IngressGateway` 为每次请求补 `traceId`
4. 最终由同一个 `QueryEngine` 执行

这意味着：

1. 同一个 `userId` 的连续请求会复用同一条 session
2. 审批、compact、provider fallback 等行为和 CLI 保持一致
3. 未来 SDK / HTTP / CLI 可以共享同一套会话恢复逻辑

## 示例文件

仓库里已经包含两个样例：

1. [examples/http-client.mjs](/Users/xutianliang/Downloads/codeclaw/examples/http-client.mjs)
2. [examples/sdk-client.ts](/Users/xutianliang/Downloads/codeclaw/examples/sdk-client.ts)
