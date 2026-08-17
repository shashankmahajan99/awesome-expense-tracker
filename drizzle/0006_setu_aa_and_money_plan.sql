CREATE TABLE IF NOT EXISTS aa_consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'setu',
  consent_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  consent_url TEXT NOT NULL DEFAULT '',
  mobile_last_four TEXT NOT NULL DEFAULT '',
  purpose_code TEXT NOT NULL DEFAULT '102',
  data_range_from TEXT NOT NULL,
  data_range_to TEXT NOT NULL,
  consent_expires_at TEXT,
  accounts_json TEXT NOT NULL DEFAULT '[]',
  last_synced_at TEXT,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_aa_consents_user_status
ON aa_consents(user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS aa_events (
  event_id TEXT PRIMARY KEY,
  consent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_aa_events_consent_received
ON aa_events(consent_id, received_at DESC);

CREATE TABLE IF NOT EXISTS aa_transaction_refs (
  provider TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(provider, external_ref, user_id)
);

CREATE TABLE IF NOT EXISTS monthly_money_plans (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  income_paise INTEGER NOT NULL DEFAULT 0,
  planned_savings_paise INTEGER NOT NULL DEFAULT 0,
  fixed_costs_paise INTEGER NOT NULL DEFAULT 0,
  intention TEXT NOT NULL DEFAULT '',
  reflection TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, month)
);

PRAGMA optimize;
