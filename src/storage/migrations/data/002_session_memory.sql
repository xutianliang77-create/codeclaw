-- L2 Session Memory · 扩展 memory_digest 表（已在 001 中定义基础列）
-- 参见 development-plan v1 W3-14..16
--
-- 001 已有：digest_id, session_id, summary_text, importance, created_at, tags_json + FK 到 sessions
-- 002 加：channel + user_id + message_count + token_estimate，并把 (channel, user_id, created_at) 索引建上
--
-- 设计取舍：
--   - DEFAULT '' / 0 让 ALTER 不需要回填（无生产数据时 trivially OK；有数据时
--     旧行 channel/user_id 为空，recall 按 (channel, user_id) 查不到——历史数据
--     按 sessionId 走 loadDigestsBySession 仍可访问，符合预期）
--   - 不动 summary_text 字段名（store.ts 在代码层把外部 summary 映射进来）

ALTER TABLE memory_digest ADD COLUMN channel        TEXT    NOT NULL DEFAULT '';
ALTER TABLE memory_digest ADD COLUMN user_id        TEXT    NOT NULL DEFAULT '';
ALTER TABLE memory_digest ADD COLUMN message_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_digest ADD COLUMN token_estimate INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_memory_digest_user
  ON memory_digest(channel, user_id, created_at DESC);
