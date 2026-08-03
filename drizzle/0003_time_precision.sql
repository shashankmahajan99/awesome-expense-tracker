ALTER TABLE transactions ADD COLUMN time_verified INTEGER NOT NULL DEFAULT 0;

PRAGMA optimize;
