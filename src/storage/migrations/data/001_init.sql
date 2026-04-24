-- CodeClaw data.db 首版 schema
-- 参见 ADR-001 §5.3（11 张表清单）、v4.2 §6.1、详细技术设计 §8.2
--
-- 设计取舍：
--   - 时间字段统一 INTEGER（Unix ms；UTC），便于比较与索引
--   - 所有"会话归属"的表都带 session_id 并建索引
--   - 外键显式开启（PRAGMA foreign_keys = ON 在 db.ts 中打开）
--   - JSON 字段用 TEXT（SQLite JSON1 扩展按需）
--   - 正文 / 大结果不存这里（走 JSONL），这里仅索引/元信息

-------------------------------------------------------------------------------
-- 1. sessions · 会话元信息
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  session_id       TEXT    PRIMARY KEY,                  -- ULID 或 gateway 下发
  channel          TEXT    NOT NULL,                     -- cli | sdk | wechat | web | mcp | http
  user_id          TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  state            TEXT    NOT NULL DEFAULT 'active',    -- active | idle | archived
  meta_json        TEXT,
  workspace        TEXT,
  UNIQUE (channel, user_id, state)                       -- 同 (channel,userId) 仅 1 个 active
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user      ON sessions(channel, user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_state     ON sessions(state);

-------------------------------------------------------------------------------
-- 2. tasks · 用户目标 / 编排任务
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  trace_id          TEXT    PRIMARY KEY,                 -- ULID
  session_id        TEXT    NOT NULL,
  goal              TEXT    NOT NULL,
  state             TEXT    NOT NULL,                    -- planning | executing | completed | halted | failed
  risk_level        TEXT,                                -- low | medium | high
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  completion_kind   TEXT,                                -- goal_met | partial_met | user_satisfied
  halt_reason       TEXT,                                -- user_interrupt | loop_detected | ...
  token_cost_total  INTEGER NOT NULL DEFAULT 0,
  usd_cost_total    REAL    NOT NULL DEFAULT 0.0,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_tasks_state   ON tasks(state);

-------------------------------------------------------------------------------
-- 3. steps · Task DAG 节点
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS steps (
  step_id          TEXT    PRIMARY KEY,                  -- ULID
  trace_id         TEXT    NOT NULL,
  step_no          INTEGER NOT NULL,
  action_type      TEXT    NOT NULL,                     -- inspect-file | run-package-script | ...
  target           TEXT,
  depends_on_json  TEXT,                                 -- JSON array of step_id
  status           TEXT    NOT NULL,                     -- ready | invoking | done | failed | replanned
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (trace_id) REFERENCES tasks(trace_id)
);
CREATE INDEX IF NOT EXISTS idx_steps_task_seq ON steps(trace_id, step_no);
CREATE INDEX IF NOT EXISTS idx_steps_status   ON steps(status);

-------------------------------------------------------------------------------
-- 4. observations · 步骤执行结果（元信息）
-- 正文在 ~/.codeclaw/sessions/{sessionId}/observations.jsonl 或
-- sessions/{sessionId}/observations/{stepId}.jsonl（>100KB 溢出）
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observations (
  observation_id    TEXT    PRIMARY KEY,                 -- ULID
  trace_id          TEXT    NOT NULL,
  step_id           TEXT    NOT NULL,
  status            TEXT    NOT NULL,                    -- completed | blocked | failed | pending
  summary           TEXT,
  latency_ms        INTEGER,
  token_cost        INTEGER,
  body_inline       INTEGER NOT NULL DEFAULT 0,          -- 1 = 正文在 observations.jsonl
  body_path         TEXT,                                -- 溢出时文件相对路径
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (trace_id) REFERENCES tasks(trace_id),
  FOREIGN KEY (step_id)  REFERENCES steps(step_id)
);
CREATE INDEX IF NOT EXISTS idx_observations_step  ON observations(step_id);
CREATE INDEX IF NOT EXISTS idx_observations_trace ON observations(trace_id, created_at);

-------------------------------------------------------------------------------
-- 5. l1_memory · 当前会话消息元信息（正文在 transcript.jsonl）
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS l1_memory (
  message_id        TEXT    PRIMARY KEY,                 -- ULID
  session_id        TEXT    NOT NULL,
  seq               INTEGER NOT NULL,
  role              TEXT    NOT NULL,                    -- user | assistant | system | tool
  source            TEXT,                                -- user | command | model | local | summary
  importance        INTEGER DEFAULT 0,
  token_cost        INTEGER DEFAULT 0,
  created_at        INTEGER NOT NULL,
  body_missing      INTEGER NOT NULL DEFAULT 0,          -- 1 = JSONL 丢失但 db 元存在
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_l1_session_seq ON l1_memory(session_id, seq);

-------------------------------------------------------------------------------
-- 6. memory_digest · L2 Session Memory 摘要索引
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_digest (
  digest_id        TEXT    PRIMARY KEY,                  -- ULID
  session_id       TEXT    NOT NULL,
  summary_text     TEXT    NOT NULL,
  importance       REAL    DEFAULT 0,
  created_at       INTEGER NOT NULL,
  tags_json        TEXT,                                 -- JSON array
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_digest_session ON memory_digest(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_digest_created ON memory_digest(created_at);

-------------------------------------------------------------------------------
-- 7. approvals · 审批待办（替代 pending-approval.json）
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approvals (
  approval_id      TEXT    PRIMARY KEY,
  session_id       TEXT,
  trace_id         TEXT,
  prompt           TEXT    NOT NULL,
  tool_name        TEXT    NOT NULL,
  detail           TEXT,
  reason           TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | expired
  created_at       INTEGER NOT NULL,
  decided_at       INTEGER,
  decision_meta    TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status  ON approvals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id);

-------------------------------------------------------------------------------
-- 8. agents · Agent Team 成员（P2）
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  agent_id         TEXT    PRIMARY KEY,                  -- ULID
  session_id       TEXT    NOT NULL,
  role             TEXT    NOT NULL,                     -- leader | code_writer | test_engineer | ...
  status           TEXT    NOT NULL,                     -- pending | running | done | failed | killed
  pid              INTEGER,
  started_at       INTEGER,
  ended_at         INTEGER,
  heartbeat_at     INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id, status);

-------------------------------------------------------------------------------
-- 9. agent_tasks · 子任务与依赖（P2）
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_tasks (
  agent_task_id    TEXT    PRIMARY KEY,
  parent_trace_id  TEXT    NOT NULL,
  agent_id         TEXT,
  goal             TEXT    NOT NULL,
  depends_on_json  TEXT,
  priority         INTEGER NOT NULL DEFAULT 0,
  state            TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (parent_trace_id) REFERENCES tasks(trace_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent ON agent_tasks(parent_trace_id);

-------------------------------------------------------------------------------
-- 10. blackboard_entries · Agent 共享状态（P2）
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blackboard_entries (
  session_id       TEXT    NOT NULL,
  key              TEXT    NOT NULL,
  value_json       TEXT    NOT NULL,
  sender           TEXT    NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (session_id, key),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

-------------------------------------------------------------------------------
-- 11. agent_messages · Agent 间消息（P2）
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_messages (
  message_id        TEXT    PRIMARY KEY,
  sender_agent_id   TEXT    NOT NULL,
  receiver_agent_id TEXT    NOT NULL,
  type              TEXT    NOT NULL,
  content_json      TEXT,
  created_at        INTEGER NOT NULL,
  consumed_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_recv
  ON agent_messages(receiver_agent_id, consumed_at);

-------------------------------------------------------------------------------
-- 12. ingress_dedup · 入站消息幂等键（见 v4.2 §6.1 / R11）
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingress_dedup (
  client_id         TEXT    PRIMARY KEY,
  channel           TEXT    NOT NULL,
  user_id           TEXT    NOT NULL,
  first_seen_at     INTEGER NOT NULL,
  ttl_ms            INTEGER NOT NULL DEFAULT 600000,     -- 默认 10 min
  last_delivery     TEXT                                  -- JSON
);
CREATE INDEX IF NOT EXISTS idx_dedup_channel_user
  ON ingress_dedup(channel, user_id, first_seen_at);

-------------------------------------------------------------------------------
-- 13. llm_calls_raw · LLM 调用记账（P0 结束前未启用 CostTracker 也先建表）
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS llm_calls_raw (
  call_id           TEXT    PRIMARY KEY,                 -- ULID
  trace_id          TEXT    NOT NULL,
  session_id        TEXT    NOT NULL,
  provider_id       TEXT    NOT NULL,
  model_id          TEXT    NOT NULL,
  input_tokens      INTEGER NOT NULL,
  output_tokens     INTEGER NOT NULL,
  usd_cost          REAL    NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_session ON llm_calls_raw(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls_raw(created_at);
