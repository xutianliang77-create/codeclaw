/**
 * CodeClaw Web · 阶段 A panels（#114 step A.3-A.9）
 *
 * 职责：
 *   - tab 切换（chat / rag / graph / mcp / hooks）
 *   - 4 个新 panel 的 fetch + 渲染（RAG / Graph / MCP / Hooks）
 *   - status-line 5s 轮询
 *   - 多会话侧栏 list / 切换 / 新建（最小可用版）
 *
 * 与 app.js 的边界：
 *   - app.js 暴露 token / sessionId 读写不便，改为 panels.js 独立从 localStorage 取
 *   - 连接 / 登出时 app.js 调 window.codeclawPanels.onConnected/onDisconnected
 */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function getToken() {
    return localStorage.getItem("codeclaw_token") || "";
  }

  async function api(method, path, body) {
    const token = getToken();
    const r = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!r.ok) {
      const msg = json?.error?.message || json?.error || `HTTP ${r.status}`;
      throw new Error(msg);
    }
    return json;
  }

  // ───────────── tab 切换 ─────────────

  function activateTab(name) {
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    document.querySelectorAll(".panel").forEach((p) => {
      const match = p.dataset.panel === name;
      p.classList.toggle("active", match);
      p.classList.toggle("hidden", !match);
    });
    // 切到面板时按需懒加载首次数据
    const loader = lazyLoaders[name];
    if (loader && !loader.loaded) {
      loader.loaded = true;
      loader.fn().catch((err) => console.warn(`[${name}] load failed:`, err));
    }
  }

  function bindTabs() {
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab));
    });
  }

  // ───────────── RAG panel ─────────────

  async function refreshRagStatus() {
    const out = $("rag-status-text");
    if (!out) return;
    try {
      const s = await api("GET", "/v1/web/rag/status");
      out.textContent = `chunks=${s.chunkCount} embedded=${s.embeddedCount}/${s.chunkCount} last=${s.lastIndexedAt ? new Date(s.lastIndexedAt).toLocaleString() : "never"}`;
    } catch (err) {
      out.textContent = `读取失败：${err.message}`;
    }
  }

  async function ragIndex() {
    const out = $("rag-status-text");
    if (out) out.textContent = "索引中...";
    try {
      const r = await api("POST", "/v1/web/rag/index");
      if (out) out.textContent = r.summary || "完成";
      refreshRagStatus();
    } catch (err) {
      if (out) out.textContent = `索引失败：${err.message}`;
    }
  }

  async function ragEmbed() {
    const out = $("rag-status-text");
    if (out) out.textContent = "embedding 中...";
    try {
      const r = await api("POST", "/v1/web/rag/embed", {});
      if (out) out.textContent = `embedded-now=${r.embeddedNow} total=${r.embeddedTotal} remaining=${r.remaining} ${r.durationMs}ms`;
      refreshRagStatus();
    } catch (err) {
      if (out) out.textContent = `embed 失败：${err.message}`;
    }
  }

  function renderRagHits(hits, mode) {
    const ol = $("rag-results");
    if (!ol) return;
    ol.innerHTML = "";
    if (!hits?.length) {
      ol.innerHTML = '<li class="muted">无结果</li>';
      return;
    }
    for (const h of hits) {
      const li = document.createElement("li");
      const head = document.createElement("div");
      head.className = "rag-hit-head";
      const score = h.rrfScore != null ? `rrf=${h.rrfScore.toFixed(4)}` : `bm25=${(h.score ?? 0).toFixed(2)}`;
      head.textContent = `${h.relPath}:${h.lineStart}-${h.lineEnd}  ${score}  ${mode}${h.source ? `(${h.source})` : ""}`;
      const pre = document.createElement("pre");
      pre.className = "rag-hit-body";
      pre.textContent = (h.content ?? "").slice(0, 1200);
      li.appendChild(head);
      li.appendChild(pre);
      ol.appendChild(li);
    }
  }

  async function ragSearch(query) {
    if (!query) return;
    const ol = $("rag-results");
    if (ol) ol.innerHTML = '<li class="muted">搜索中...</li>';
    try {
      const r = await api("POST", "/v1/web/rag/search", { query, topK: 8 });
      renderRagHits(r.hits, r.mode);
    } catch (err) {
      if (ol) ol.innerHTML = `<li class="error">搜索失败：${err.message}</li>`;
    }
  }

  function bindRag() {
    $("rag-refresh-status")?.addEventListener("click", refreshRagStatus);
    $("rag-index-btn")?.addEventListener("click", ragIndex);
    $("rag-embed-btn")?.addEventListener("click", ragEmbed);
    $("rag-search-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      ragSearch($("rag-query")?.value?.trim() || "");
    });
  }

  // ───────────── Graph panel ─────────────

  async function refreshGraphStatus() {
    const out = $("graph-status-text");
    if (!out) return;
    try {
      const s = await api("GET", "/v1/web/graph/status");
      out.textContent = `symbols=${s.symbols} imports=${s.imports} calls=${s.calls}`;
    } catch (err) {
      out.textContent = `读取失败：${err.message}`;
    }
  }

  async function graphBuild() {
    const out = $("graph-status-text");
    if (out) out.textContent = "构建中...";
    try {
      const r = await api("POST", "/v1/web/graph/build");
      if (out) out.textContent = r.summary || "完成";
      refreshGraphStatus();
    } catch (err) {
      if (out) out.textContent = `构建失败：${err.message}`;
    }
  }

  async function graphQuery(type, arg, arg2) {
    const out = $("graph-result");
    if (out) out.textContent = "查询中...";
    try {
      const r = await api("POST", "/v1/web/graph/query", { type, arg, ...(arg2 ? { arg2 } : {}) });
      if (out) out.textContent = JSON.stringify(r.result, null, 2);
    } catch (err) {
      if (out) out.textContent = `查询失败：${err.message}`;
    }
  }

  function bindGraph() {
    $("graph-refresh-status")?.addEventListener("click", refreshGraphStatus);
    $("graph-build-btn")?.addEventListener("click", graphBuild);
    $("graph-query-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const type = $("graph-type")?.value || "callers";
      const arg = $("graph-arg")?.value?.trim() || "";
      const arg2 = $("graph-arg2")?.value?.trim() || "";
      if (!arg) return;
      graphQuery(type, arg, arg2);
    });
  }

  // ───────────── MCP panel ─────────────

  function renderMcpServers(servers) {
    const ul = $("mcp-server-list");
    if (!ul) return;
    ul.innerHTML = "";
    if (!servers?.length) {
      ul.innerHTML = '<li class="muted">未配置 MCP servers</li>';
      return;
    }
    for (const s of servers) {
      const li = document.createElement("li");
      li.className = `mcp-server status-${s.status}`;
      const head = document.createElement("div");
      head.innerHTML = `<strong>${s.name}</strong> · ${s.status} · tools=${s.toolCount} · restarts=${s.restartCount}`;
      li.appendChild(head);
      if (s.lastError) {
        const err = document.createElement("div");
        err.className = "mcp-server-error";
        err.textContent = `last error: ${s.lastError}`;
        li.appendChild(err);
      }
      const browseBtn = document.createElement("button");
      browseBtn.textContent = "浏览 tools";
      browseBtn.addEventListener("click", () => listMcpTools(s.name));
      li.appendChild(browseBtn);
      ul.appendChild(li);
    }
  }

  async function refreshMcp() {
    const summary = $("mcp-summary");
    if (summary) summary.textContent = "...";
    try {
      const r = await api("GET", "/v1/web/mcp/servers");
      if (summary) summary.textContent = `${r.servers.length} server(s)`;
      renderMcpServers(r.servers);
    } catch (err) {
      if (summary) summary.textContent = `读取失败：${err.message}`;
      const ul = $("mcp-server-list");
      if (ul) ul.innerHTML = `<li class="error">${err.message}</li>`;
    }
  }

  async function listMcpTools(serverName) {
    const out = $("mcp-test-result");
    if (out) out.textContent = `获取 ${serverName} tools...`;
    try {
      const r = await api("GET", `/v1/web/mcp/tools?server=${encodeURIComponent(serverName)}`);
      if (out) out.textContent = JSON.stringify(r.tools, null, 2);
      $("mcp-test-server").value = serverName;
    } catch (err) {
      if (out) out.textContent = `读取失败：${err.message}`;
    }
  }

  async function mcpCall(server, tool, argsJson) {
    const out = $("mcp-test-result");
    let args;
    try {
      args = argsJson.trim() ? JSON.parse(argsJson) : {};
    } catch (err) {
      if (out) out.textContent = `args 不是合法 JSON：${err.message}`;
      return;
    }
    if (out) out.textContent = `调用 ${server}.${tool}...`;
    try {
      const r = await api("POST", "/v1/web/mcp/call", { server, tool, args });
      if (out) out.textContent = JSON.stringify(r, null, 2);
    } catch (err) {
      if (out) out.textContent = `调用失败：${err.message}`;
    }
  }

  function bindMcp() {
    $("mcp-refresh")?.addEventListener("click", refreshMcp);
    $("mcp-test-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const s = $("mcp-test-server")?.value?.trim();
      const t = $("mcp-test-tool")?.value?.trim();
      if (!s || !t) return;
      mcpCall(s, t, $("mcp-test-args")?.value || "{}");
    });
  }

  // ───────────── Hooks panel ─────────────

  function renderHooks(events) {
    const out = $("hooks-content");
    if (!out) return;
    if (!events || Object.keys(events).length === 0) {
      out.textContent = "（settings.json 中未配置任何 hook）";
      return;
    }
    out.textContent = JSON.stringify(events, null, 2);
  }

  async function refreshHooks() {
    const summary = $("hooks-summary");
    if (summary) summary.textContent = "...";
    try {
      const r = await api("GET", "/v1/web/hooks");
      const count = r.events ? Object.keys(r.events).length : 0;
      if (summary) summary.textContent = `${count} 类事件配置`;
      renderHooks(r.events);
    } catch (err) {
      if (summary) summary.textContent = `读取失败：${err.message}`;
    }
  }

  async function reloadHooks() {
    const summary = $("hooks-summary");
    if (summary) summary.textContent = "重载中...";
    try {
      const r = await api("POST", "/v1/web/hooks/reload");
      const count = r.events ? Object.keys(r.events).length : 0;
      if (summary) summary.textContent = `重载完成 · ${count} 类事件`;
      renderHooks(r.events);
    } catch (err) {
      if (summary) summary.textContent = `重载失败：${err.message}`;
    }
  }

  function bindHooks() {
    $("hooks-reload")?.addEventListener("click", reloadHooks);
  }

  // ───────────── status line（5s 轮询） ─────────────

  let statusTimer = null;

  async function refreshStatusLine() {
    const out = $("status-line-text");
    if (!out) return;
    try {
      const r = await api("GET", "/v1/web/status-line");
      out.textContent = r.text;
    } catch {
      out.textContent = "[status line failed]";
    }
  }

  function startStatusLineTimer() {
    refreshStatusLine();
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(refreshStatusLine, 5000);
  }

  function stopStatusLineTimer() {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  // ───────────── 多会话侧栏 ─────────────

  async function refreshSessionList() {
    const ul = $("session-list");
    if (!ul) return;
    try {
      const r = await api("GET", "/v1/web/sessions");
      ul.innerHTML = "";
      const current = localStorage.getItem("codeclaw_session_id") || "";
      for (const s of r.sessions ?? []) {
        const li = document.createElement("li");
        li.className = "session-item";
        if (s.sessionId === current) li.classList.add("active");
        li.dataset.id = s.sessionId;
        li.innerHTML = `
          <div class="session-id">${s.sessionId.replace(/^web-/, "").slice(0, 12)}</div>
          <div class="session-meta muted">
            ${new Date(s.lastSeenAt ?? s.createdAt).toLocaleTimeString()}
          </div>
        `;
        ul.appendChild(li);
      }
    } catch (err) {
      ul.innerHTML = `<li class="error">读取失败：${err.message}</li>`;
    }
  }

  async function newSession() {
    try {
      const r = await api("POST", "/v1/web/sessions");
      // 阶段 A：仅刷新列表；切换 session 的完整 SSE 重连留给 stage B
      console.info("[panels] 新会话已创建：", r.sessionId);
      refreshSessionList();
    } catch (err) {
      alert(`新会话失败：${err.message}`);
    }
  }

  function bindSessions() {
    $("new-session-btn")?.addEventListener("click", newSession);
  }

  // ───────────── lifecycle ─────────────

  const lazyLoaders = {
    rag: { loaded: false, fn: refreshRagStatus },
    graph: { loaded: false, fn: refreshGraphStatus },
    mcp: { loaded: false, fn: refreshMcp },
    hooks: { loaded: false, fn: refreshHooks },
  };

  function init() {
    bindTabs();
    bindRag();
    bindGraph();
    bindMcp();
    bindHooks();
    bindSessions();
  }

  function onConnected() {
    refreshSessionList();
    startStatusLineTimer();
  }

  function onDisconnected() {
    stopStatusLineTimer();
    Object.values(lazyLoaders).forEach((l) => { l.loaded = false; });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.codeclawPanels = { onConnected, onDisconnected };
})();
