-- XPush D1 schema (单用户私有部署)
-- 单用户场景：users 表仅 1 行，所有数据归属该用户。

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT,
  created_at  INTEGER NOT NULL          -- epoch ms
);

-- 渠道：webhook | api | telegram | dingtalk
CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  key         TEXT NOT NULL,            -- 入口路径密钥 /w/:key 等
  secret      TEXT,                     -- 钉钉加签 / Telegram secret_token 等
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_key ON channels(key);
CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);

-- 消息：format = text | markdown | html；level = info | success | warning | urgent
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  channel_id  TEXT,
  title       TEXT,
  body        TEXT NOT NULL,
  format      TEXT NOT NULL DEFAULT 'text',
  level       TEXT NOT NULL DEFAULT 'info',
  meta_json   TEXT,                     -- 来源 IP/规则等附加信息（JSON）
  read        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_user_time ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(user_id, read);

-- Web Push 订阅
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions(endpoint);
