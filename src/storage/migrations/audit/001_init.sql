-- CodeClaw audit.db 首版 schema（独立 DB，v4.2 §7.2 / 详细技术设计 §7.2）
--
-- 特征：
--   - 独立 SQLite 文件，主库损坏不牵连
--   - 仅应用 append 句柄写入；DBA / 运维用独立只读句柄
--   - event_hash = BLAKE3(prev_hash || event_id || actor || action || resource || decision || timestamp)
--   - 链式哈希保证不可篡改

CREATE TABLE IF NOT EXISTS audit_events (
  event_id        TEXT    PRIMARY KEY,                  -- ULID
  trace_id        TEXT    NOT NULL,
  session_id      TEXT,
  actor           TEXT    NOT NULL,                     -- user | tool | skill | system | agent:<role>
  action          TEXT    NOT NULL,                     -- tool.bash | skill.run | llm.call | permission.check | ...
  resource        TEXT,
  decision        TEXT    NOT NULL,                     -- allow | deny | approved | rejected | pending
  mode            TEXT,                                 -- PermissionMode
  reason          TEXT,
  details_json    TEXT,
  prev_hash       TEXT    NOT NULL,
  event_hash      TEXT    NOT NULL,
  timestamp       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor, timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_ts    ON audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_decision ON audit_events(decision);
