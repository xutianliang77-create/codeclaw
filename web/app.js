/**
 * CodeClaw Web SPA · vanilla JS
 *
 * 流程：
 *   1. 用户在 token 输入框填 CODECLAW_WEB_TOKEN，点 [连接]
 *   2. POST /v1/web/sessions 拿到 sessionId
 *   3. 建立 EventSource (with token query) 监听 SSE
 *   4. 用户输入 → POST /v1/web/messages
 *   5. 后端 EngineEvent 经 SSE 推回，追加到消息列表
 *
 * 设计取舍：
 *   - 不引入 React/Vue 等框架（ADR-005 要求 vanilla）
 *   - 不渲染 markdown / 代码高亮（XSS 防御 + 阶段 C 最小可见）
 *   - token 存 localStorage（跨刷新保留；用户可点 [登出] 清除）
 *   - EventSource 无原生 header 支持 → 用 `?token=` query param（HTTPS 下足矣）
 */

const $ = (id) => document.getElementById(id);

const els = {
  tokenInput: $("token-input"),
  connectBtn: $("connect-btn"),
  logoutBtn: $("logout-btn"),
  authBar: $("auth-bar"),
  chat: $("chat"),
  messages: $("messages"),
  composer: $("composer"),
  input: $("input"),
  sendBtn: $("send-btn"),
  status: $("status"),
};

const state = {
  token: localStorage.getItem("codeclaw_token") || "",
  sessionId: null,
  eventSource: null,
  currentStreamMsg: null, // 当前正在 streaming 的 assistant 气泡
};

// ───────────── UI 工具 ─────────────

function setStatus(text, connected) {
  els.status.textContent = text;
  els.status.className = "status " + (connected ? "connected" : "disconnected");
}

/**
 * 设置气泡内容。assistant 走 markdown 渲染（marked + DOMPurify + highlight.js）；
 * 其他角色（user/tool/error/approval）继续用 textContent 防 XSS——它们的内容来源
 * 信任度更低（user 输入 / 系统拼接）或者格式是固定的纯文本提示。
 */
function setBubbleContent(bubble, kind, text) {
  if (kind === "assistant" && typeof window.marked !== "undefined" && typeof window.DOMPurify !== "undefined") {
    const html = window.marked.parse(text, { breaks: true, gfm: true });
    bubble.innerHTML = window.DOMPurify.sanitize(html);
    // 给所有 <pre><code> 跑高亮
    if (typeof window.hljs !== "undefined") {
      bubble.querySelectorAll("pre code").forEach((el) => {
        try { window.hljs.highlightElement(el); } catch { /* noop */ }
      });
    }
  } else {
    bubble.textContent = text; // 防 XSS 兜底
  }
}

function appendMessage(kind, text, meta = "") {
  const wrap = document.createElement("div");
  wrap.className = "msg " + kind;
  if (meta) {
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = meta;
    wrap.appendChild(m);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  setBubbleContent(bubble, kind, text);
  wrap.appendChild(bubble);
  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
  return bubble;
}

// ───────────── 连接生命周期 ─────────────

async function connect() {
  const token = els.tokenInput.value.trim();
  if (!token) {
    appendMessage("error", "请填 CODECLAW_WEB_TOKEN");
    return;
  }
  state.token = token;
  localStorage.setItem("codeclaw_token", token);

  setStatus("正在创建会话...", false);
  try {
    const r = await fetch("/v1/web/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
    });
    if (!r.ok) throw new Error("创建 session 失败：HTTP " + r.status);
    const meta = await r.json();
    state.sessionId = meta.sessionId;
    appendMessage("assistant", `[session: ${meta.sessionId}]`, "");

    setStatus("已连接", true);
    els.authBar.classList.add("hidden");
    els.chat.classList.remove("hidden");
    els.logoutBtn.classList.remove("hidden");
    openStream();
  } catch (err) {
    setStatus("连接失败", false);
    appendMessage("error", String(err));
  }
}

function openStream() {
  // EventSource 不支持自定义 header → 用 ?token= 鉴权
  // 注意：当前后端 stream handler 仍读 Authorization 头，所以这里需要服务端
  // 适配（后续改 server 接受 token query），或用 fetch + ReadableStream 替代
  // 阶段 C 临时方案：用 fetch streaming 模拟 EventSource
  fetchStream();
}

async function fetchStream() {
  try {
    const resp = await fetch(
      "/v1/web/stream?sessionId=" + encodeURIComponent(state.sessionId),
      { headers: { Authorization: "Bearer " + state.token } }
    );
    if (!resp.ok || !resp.body) {
      setStatus("流连接失败 HTTP " + resp.status, false);
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE 帧以 \n\n 分隔
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleSseFrame(frame);
      }
    }
    setStatus("流已结束", false);
  } catch (err) {
    setStatus("流出错", false);
    appendMessage("error", String(err));
  }
}

function handleSseFrame(frame) {
  // frame 形如 "data: {...}" 或 ": ping"
  const lines = frame.split("\n");
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      const json = line.slice(5).trim();
      try {
        renderEvent(JSON.parse(json));
      } catch (e) {
        console.warn("bad SSE JSON:", json);
      }
    }
  }
}

function renderEvent(ev) {
  switch (ev.type) {
    case "phase":
      // 不在 UI 里显示 phase（避免噪音），仅打印
      console.debug("[phase]", ev.phase);
      break;
    case "message-start":
      state.currentStreamMsg = appendMessage("assistant", "", "assistant");
      // 流式阶段累积 raw 文本到气泡 dataset，complete 时一次性 markdown 渲染
      state.currentStreamMsg.dataset.raw = "";
      break;
    case "message-delta":
      if (state.currentStreamMsg) {
        // delta 阶段用 textContent 显示纯文本，避免不完整 markdown 闪烁
        const raw = (state.currentStreamMsg.dataset.raw || "") + ev.delta;
        state.currentStreamMsg.dataset.raw = raw;
        state.currentStreamMsg.textContent = raw;
        els.messages.scrollTop = els.messages.scrollHeight;
      }
      break;
    case "message-complete":
      // complete 时拿完整文本走 markdown 渲染（marked + DOMPurify + highlight.js）
      if (state.currentStreamMsg) {
        setBubbleContent(state.currentStreamMsg, "assistant", ev.text);
      } else {
        appendMessage("assistant", ev.text, "assistant");
      }
      state.currentStreamMsg = null;
      break;
    case "tool-start":
      appendMessage("tool", `▶ ${ev.toolName}: ${ev.detail}`);
      break;
    case "tool-end":
      appendMessage("tool", `■ ${ev.toolName}: ${ev.status}`);
      break;
    case "approval-request":
      appendMessage(
        "approval",
        `审批待办 [${ev.approvalId}]\n  工具: ${ev.toolName}\n  详情: ${ev.detail}\n  原因: ${ev.reason}\n  队列: ${ev.queuePosition}/${ev.totalPending}\n回复 /approve 或 /deny`
      );
      break;
    case "approval-cleared":
      appendMessage("tool", `✓ 已处理 ${ev.approvalId}`);
      break;
    default:
      console.debug("[event]", ev);
  }
}

// ───────────── 提交输入 ─────────────

async function sendMessage(text) {
  if (!state.sessionId || !text.trim()) return;
  appendMessage("user", text, "user");
  try {
    const r = await fetch("/v1/web/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + state.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: state.sessionId, input: text }),
    });
    if (!r.ok) {
      appendMessage("error", "提交失败 HTTP " + r.status);
    }
  } catch (err) {
    appendMessage("error", String(err));
  }
}

function logout() {
  localStorage.removeItem("codeclaw_token");
  state.token = "";
  state.sessionId = null;
  els.authBar.classList.remove("hidden");
  els.chat.classList.add("hidden");
  els.logoutBtn.classList.add("hidden");
  els.messages.innerHTML = "";
  setStatus("已登出", false);
}

// ───────────── 事件绑定 ─────────────

els.connectBtn.addEventListener("click", connect);
els.logoutBtn.addEventListener("click", logout);

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value;
  els.input.value = "";
  sendMessage(text);
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

// 启动：localStorage 有 token 时自动填入
if (state.token) {
  els.tokenInput.value = state.token;
}
