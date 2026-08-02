CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reminder_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  personality TEXT NOT NULL DEFAULT 'Balanced' CHECK (personality IN ('Gentle','Balanced','Strict')),
  preferred_time TEXT NOT NULL DEFAULT '21:30',
  quiet_start TEXT NOT NULL DEFAULT '23:00',
  quiet_end TEXT NOT NULL DEFAULT '07:00',
  important_amount_paise INTEGER NOT NULL DEFAULT 100000,
  minimum_total_paise INTEGER NOT NULL DEFAULT 30000,
  weekly_cleanup INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS review_groups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  context TEXT,
  category TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  merchant TEXT NOT NULL,
  description TEXT,
  occurred_at TEXT NOT NULL,
  category TEXT,
  review_status TEXT NOT NULL DEFAULT 'unresolved' CHECK (review_status IN ('unresolved','explained','known','deferred','auto_resolved')),
  context TEXT,
  importance_score REAL NOT NULL DEFAULT 0,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  is_reversed INTEGER NOT NULL DEFAULT 0,
  is_own_transfer INTEGER NOT NULL DEFAULT 0,
  group_id TEXT REFERENCES review_groups(id) ON DELETE SET NULL,
  dedupe_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_transactions_review_queue ON transactions(user_id, review_status, occurred_at, importance_score DESC);

CREATE TABLE IF NOT EXISTS daily_reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_date TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'scheduled' CHECK (state IN ('not_required','scheduled','notified','started','partially_completed','completed','deferred')),
  unresolved_count INTEGER NOT NULL DEFAULT 0,
  unresolved_amount_paise INTEGER NOT NULL DEFAULT 0,
  notified_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, review_date)
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_date TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, review_date)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
