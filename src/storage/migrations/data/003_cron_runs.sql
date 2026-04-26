-- cron 任务运行历史（#116 阶段 🅑）
--
-- 与 ~/.codeclaw/cron-runs/<task-id>/<日期>.jsonl 的 jsonl 历史并行存在：
--   - jsonl：单条 / 按日切，方便 grep 与离线查阅
--   - sqlite cron_runs：方便聚合查询（按 task_id / 状态 / 时间范围）
--
-- 设计取舍：
--   - 不外键到 sessions（cron 任务不属于任何 session）
--   - output 与 error 限 16KB / 4KB（runner 已截，但 schema 不强制 length 上限）
--   - status 用 TEXT enum：ok | error | timeout
--   - task_id / status / 时间索引，覆盖 list 端最常见 查询

CREATE TABLE IF NOT EXISTS cron_runs (
  run_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT    NOT NULL,
  task_name     TEXT    NOT NULL,
  task_kind     TEXT    NOT NULL,                -- slash | prompt | shell
  started_at    INTEGER NOT NULL,                -- Unix ms
  ended_at      INTEGER NOT NULL,
  status        TEXT    NOT NULL,                -- ok | error | timeout
  output        TEXT    NOT NULL DEFAULT '',
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_task     ON cron_runs(task_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_cron_runs_status   ON cron_runs(status, ended_at);
CREATE INDEX IF NOT EXISTS idx_cron_runs_recent   ON cron_runs(ended_at);
