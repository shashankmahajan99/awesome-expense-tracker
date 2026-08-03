ALTER TABLE transactions ADD COLUMN account_tag TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS push_devices (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES mobile_sessions(id) ON DELETE CASCADE,
  environment TEXT NOT NULL DEFAULT 'production',
  app_bundle TEXT NOT NULL DEFAULT 'com.shashankmahajan.paisa',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_push_devices_user
ON push_devices(user_id, session_id);

PRAGMA optimize;
