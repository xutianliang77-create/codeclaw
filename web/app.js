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
  cost: $("cost"),
  settingsBtn: $("settings-btn"),
  settingsPanel: $("settings-panel"),
  settingsClose: $("settings-close"),
  settingsBody: $("settings-body"),
  attachInput: $("attach-input"),
  attachmentTray: $("attachment-tray"),
  // A.3: 多面板布局 + 状态栏（首屏 hidden，连接成功后显示）
  workspace: $("workspace"),
  tabs: $("tabs"),
  statusLine: $("status-line"),
};

const state = {
  token: localStorage.getItem("codeclaw_token") || "",
  sessionId: null,
  eventSource: null,
  currentStreamMsg: null, // 当前正在 streaming 的 assistant 气泡
  costTimer: null,
  pendingAttachments: [], // [{ kind, dataUrl, fileName, mimeType }]
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
    els.workspace?.classList.remove("hidden");
    els.tabs?.classList.remove("hidden");
    els.statusLine?.classList.remove("hidden");
    els.logoutBtn.classList.remove("hidden");
    els.cost.classList.remove("hidden");
    els.settingsBtn.classList.remove("hidden");
    refreshCost();
    state.costTimer = setInterval(refreshCost, 5000);
    openStream();
    // A.3：让 panels.js 在连接后初始化（panel 切换 / 数据加载）
    if (typeof window.codeclawPanels?.onConnected === "function") {
      try { window.codeclawPanels.onConnected(state.token); } catch { /* noop */ }
    }
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
      renderApprovalCard(ev);
      break;
    case "approval-cleared":
      markApprovalResolved(ev.approvalId);
      break;
    default:
      console.debug("[event]", ev);
  }
}

// ───────────── 附件上传 #70-D ─────────────

function renderAttachmentTray() {
  if (state.pendingAttachments.length === 0) {
    els.attachmentTray.classList.add("hidden");
    els.attachmentTray.innerHTML = "";
    return;
  }
  els.attachmentTray.classList.remove("hidden");
  els.attachmentTray.innerHTML = state.pendingAttachments
    .map((a, i) => `
      <div class="attachment-chip" data-i="${i}">
        ${a.dataUrl.startsWith("data:image/") ? `<img src="${escapeHtml(a.dataUrl)}" alt="" />` : ""}
        <span class="attachment-name">${escapeHtml(a.fileName || "image")}</span>
        <button class="attachment-remove" type="button" data-i="${i}" aria-label="移除">×</button>
      </div>
    `)
    .join("");
  els.attachmentTray.querySelectorAll(".attachment-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.i);
      state.pendingAttachments.splice(idx, 1);
      renderAttachmentTray();
    });
  });
}

async function pickAttachment(file) {
  // 5MB 上限（后端 readJsonBody maxBytes 8MB，留余量给 base64 膨胀）
  if (file.size > 5 * 1024 * 1024) {
    appendMessage("error", `图片太大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 5 MB`);
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  state.pendingAttachments.push({
    kind: "image",
    dataUrl,
    fileName: file.name,
    mimeType: file.type || "image/png",
  });
  renderAttachmentTray();
}

// ───────────── 审批内嵌 #70-C ─────────────

function renderApprovalCard(ev) {
  const wrap = document.createElement("div");
  wrap.className = "msg approval";
  wrap.dataset.approvalId = ev.approvalId;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `审批待办 · 队列 ${ev.queuePosition}/${ev.totalPending}`;
  wrap.appendChild(meta);

  const card = document.createElement("div");
  card.className = "approval-card";
  card.innerHTML = `
    <div class="approval-row"><span class="approval-label">tool</span><code>${escapeHtml(ev.toolName)}</code></div>
    <div class="approval-row"><span class="approval-label">detail</span><span>${escapeHtml(ev.detail)}</span></div>
    <div class="approval-row"><span class="approval-label">reason</span><span>${escapeHtml(ev.reason)}</span></div>
    <div class="approval-row approval-id"><span class="approval-label">id</span><code>${escapeHtml(ev.approvalId)}</code></div>
  `;
  wrap.appendChild(card);

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const approveBtn = document.createElement("button");
  approveBtn.className = "approval-btn approve";
  approveBtn.textContent = "✓ 批准";
  approveBtn.addEventListener("click", () => {
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    sendMessage(`/approve ${ev.approvalId}`);
  });
  const denyBtn = document.createElement("button");
  denyBtn.className = "approval-btn deny";
  denyBtn.textContent = "✗ 拒绝";
  denyBtn.addEventListener("click", () => {
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    sendMessage(`/deny ${ev.approvalId}`);
  });
  actions.appendChild(approveBtn);
  actions.appendChild(denyBtn);
  wrap.appendChild(actions);

  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function markApprovalResolved(approvalId) {
  const card = els.messages.querySelector(`[data-approval-id="${CSS.escape(approvalId)}"]`);
  if (card) {
    card.classList.add("approval-resolved");
    card.querySelectorAll(".approval-btn").forEach((b) => (b.disabled = true));
    const tag = document.createElement("div");
    tag.className = "approval-resolved-tag";
    tag.textContent = "✓ 已处理";
    card.appendChild(tag);
  }
}

// ───────────── 设置中心 #70-B ─────────────

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

function renderProviderCard(role, p) {
  if (!p) {
    return `<div class="provider-card"><div class="role">${role}</div><div class="muted">未配置</div></div>`;
  }
  const availClass = p.available ? "available-yes" : "available-no";
  const availLabel = p.available ? "✓ 可用" : "✗ 不可用";
  return `
    <div class="provider-card">
      <div class="role">${role}</div>
      <div class="name">${escapeHtml(p.displayName)} <span class="${availClass}">${availLabel}</span></div>
      <dl>
        <dt>type</dt><dd>${escapeHtml(p.type)} (${escapeHtml(p.kind)})</dd>
        <dt>model</dt><dd>${escapeHtml(p.model)}</dd>
        <dt>baseUrl</dt><dd>${escapeHtml(p.baseUrl)}</dd>
        ${p.reason ? `<dt>状态</dt><dd>${escapeHtml(p.reason)}</dd>` : ""}
      </dl>
    </div>
  `;
}

async function refreshSettings() {
  els.settingsBody.innerHTML = '<p class="muted">加载中...</p>';
  try {
    const r = await fetch("/v1/web/providers", {
      headers: { Authorization: "Bearer " + state.token },
    });
    if (!r.ok) {
      els.settingsBody.innerHTML = `<p class="muted">加载失败：HTTP ${r.status}</p>`;
      return;
    }
    const data = await r.json();
    els.settingsBody.innerHTML =
      renderProviderCard("当前 provider", data.current) +
      renderProviderCard("fallback", data.fallback) +
      `<p class="muted" style="margin-top:1rem;">配置位于 <code>~/.codeclaw/config.yaml</code> + <code>providers.json</code>。<br>修改后需 restart codeclaw web。</p>`;
  } catch (err) {
    els.settingsBody.innerHTML = `<p class="muted">异常：${escapeHtml(String(err))}</p>`;
  }
}

function openSettings() {
  els.settingsPanel.classList.remove("hidden");
  els.settingsPanel.setAttribute("aria-hidden", "false");
  refreshSettings();
}

function closeSettings() {
  els.settingsPanel.classList.add("hidden");
  els.settingsPanel.setAttribute("aria-hidden", "true");
}

// ───────────── Cost dashboard #70-A ─────────────

async function refreshCost() {
  if (!state.sessionId || !state.token) return;
  try {
    const r = await fetch(
      "/v1/web/cost?sessionId=" + encodeURIComponent(state.sessionId),
      { headers: { Authorization: "Bearer " + state.token } }
    );
    if (!r.ok) return;
    const data = await r.json();
    if (!data.enabled) {
      els.cost.textContent = "cost: disabled";
      return;
    }
    const s = data.session;
    const t = data.today;
    els.cost.innerHTML =
      "<span title='本会话累计 LLM 调用成本'>session " + s.totalUsdCostFormatted +
      " · " + s.callCount + " calls · " + (s.totalInputTokens + s.totalOutputTokens) + " tok</span>" +
      " · " +
      "<span title='今日跨会话累计'>today " + t.totalUsdCostFormatted + "</span>";
  } catch (err) {
    console.warn("[cost] refresh failed:", err);
  }
}

// ───────────── 提交输入 ─────────────

async function sendMessage(text) {
  if (!state.sessionId) return;
  // 允许仅图无文：text 为空时用占位避免后端 400
  const input = text.trim() || (state.pendingAttachments.length ? "[image]" : "");
  if (!input) return;
  const attachments = state.pendingAttachments.slice();
  state.pendingAttachments = [];
  renderAttachmentTray();

  let metaParts = ["user"];
  if (attachments.length) metaParts.push(`+${attachments.length} 张图片`);
  appendMessage("user", input, metaParts.join(" "));
  try {
    const r = await fetch("/v1/web/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + state.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: state.sessionId,
        input,
        ...(attachments.length ? { attachments } : {}),
      }),
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
  if (state.costTimer) {
    clearInterval(state.costTimer);
    state.costTimer = null;
  }
  els.authBar.classList.remove("hidden");
  els.workspace?.classList.add("hidden");
  els.tabs?.classList.add("hidden");
  els.statusLine?.classList.add("hidden");
  els.logoutBtn.classList.add("hidden");
  els.cost.classList.add("hidden");
  els.cost.textContent = "";
  els.settingsBtn.classList.add("hidden");
  closeSettings();
  els.messages.innerHTML = "";
  setStatus("已登出", false);
  if (typeof window.codeclawPanels?.onDisconnected === "function") {
    try { window.codeclawPanels.onDisconnected(); } catch { /* noop */ }
  }
}

// ───────────── 事件绑定 ─────────────

els.connectBtn.addEventListener("click", connect);
els.logoutBtn.addEventListener("click", logout);
els.settingsBtn.addEventListener("click", openSettings);
els.settingsClose.addEventListener("click", closeSettings);
els.attachInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) pickAttachment(file);
  e.target.value = "";
});
// 拖拽到对话区也能上传
els.chat?.addEventListener("dragover", (e) => {
  e.preventDefault();
});
els.chat?.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith("image/")) pickAttachment(file);
});

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
