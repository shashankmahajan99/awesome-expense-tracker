CREATE TABLE IF NOT EXISTS payment_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'bank',
  institution TEXT NOT NULL DEFAULT '',
  last_four TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_payment_accounts_user_kind
ON payment_accounts(user_id, kind, name);

INSERT OR IGNORE INTO payment_accounts (id,user_id,name,kind,institution)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),user_id,account_tag,
  CASE WHEN lower(account_tag) LIKE '%card%' THEN 'card' WHEN lower(account_tag) LIKE '%paytm%' OR lower(account_tag) LIKE '%wallet%' THEN 'wallet' ELSE 'bank' END,
  CASE WHEN lower(account_tag) LIKE '%icici%' THEN 'ICICI' WHEN lower(account_tag) LIKE '%hdfc%' THEN 'HDFC' WHEN lower(account_tag) LIKE '%axis%' THEN 'Axis' WHEN lower(account_tag) LIKE '%sbi%' THEN 'SBI' ELSE '' END
FROM transactions WHERE trim(account_tag)<>'' GROUP BY user_id,account_tag;

PRAGMA optimize;
