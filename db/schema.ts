// Canonical D1 schema documentation. Runtime initialization and migrations use
// the same statements from drizzle/0000_paisa.sql.
export const tables = {
  users: ["id", "email", "display_name", "created_at", "last_seen_at"],
  transactions: ["id", "user_id", "amount_paise", "merchant", "occurred_at", "time_verified", "category", "review_status", "context", "importance_score", "dedupe_key", "source", "account_tag"],
  payment_accounts: ["id", "user_id", "name", "kind", "institution", "last_four", "aliases", "created_at", "updated_at"],
  daily_reviews: ["id", "user_id", "review_date", "state", "unresolved_count", "unresolved_amount_paise", "notified_at", "completed_at"],
  reminder_preferences: ["user_id", "personality", "preferred_time", "quiet_start", "quiet_end", "important_amount_paise", "weekly_cleanup", "timezone"],
  review_groups: ["id", "user_id", "title", "context", "category"],
  notification_deliveries: ["id", "user_id", "review_date", "status", "provider_message_id", "attempted_at"],
  audit_log: ["id", "user_id", "action", "entity_type", "entity_id", "created_at"],
  mobile_sessions: ["id", "user_id", "token_hash", "device_name", "created_at", "last_used_at", "revoked_at"],
  push_devices: ["token", "user_id", "session_id", "environment", "app_bundle", "created_at", "updated_at"],
  transaction_tombstones: ["user_id", "transaction_id", "deleted_at"],
} as const;
