CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lender TEXT NOT NULL DEFAULT '',
  loan_type TEXT NOT NULL DEFAULT 'personal',
  account_number TEXT NOT NULL DEFAULT '',
  principal_paise INTEGER NOT NULL DEFAULT 0,
  outstanding_paise INTEGER NOT NULL DEFAULT 0,
  interest_rate_bps INTEGER NOT NULL DEFAULT 0,
  tenure_months INTEGER NOT NULL DEFAULT 0,
  emi_amount_paise INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  next_due_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  no_cost_emi INTEGER NOT NULL DEFAULT 0,
  total_interest_paise INTEGER NOT NULL DEFAULT 0,
  processing_fee_paise INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_loans_user_status ON loans(user_id, status, next_due_date);

ALTER TABLE transactions ADD COLUMN loan_id TEXT REFERENCES loans(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN emi_number INTEGER;
ALTER TABLE transactions ADD COLUMN principal_component_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN interest_component_paise INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_transactions_user_loan ON transactions(user_id, loan_id, occurred_at);

PRAGMA optimize;
