import { dedupeKey, importance, matchExplanation, normalizeMerchant, shouldNotify } from "./domain.mjs";

const schema = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, display_name TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS reminder_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, personality TEXT NOT NULL DEFAULT 'Balanced', preferred_time TEXT NOT NULL DEFAULT '21:30', quiet_start TEXT NOT NULL DEFAULT '23:00', quiet_end TEXT NOT NULL DEFAULT '07:00', important_amount_paise INTEGER NOT NULL DEFAULT 100000, minimum_total_paise INTEGER NOT NULL DEFAULT 30000, weekly_cleanup INTEGER NOT NULL DEFAULT 1, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS review_groups (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, context TEXT, category TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, amount_paise INTEGER NOT NULL, merchant TEXT NOT NULL, description TEXT, occurred_at TEXT NOT NULL, category TEXT, review_status TEXT NOT NULL DEFAULT 'unresolved', context TEXT, importance_score REAL NOT NULL DEFAULT 0, is_recurring INTEGER NOT NULL DEFAULT 0, is_reversed INTEGER NOT NULL DEFAULT 0, is_own_transfer INTEGER NOT NULL DEFAULT 0, group_id TEXT REFERENCES review_groups(id) ON DELETE SET NULL, dedupe_key TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, dedupe_key))`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_review_queue ON transactions(user_id, review_status, occurred_at, importance_score DESC)`,
  `CREATE TABLE IF NOT EXISTS daily_reviews (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, review_date TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'scheduled', unresolved_count INTEGER NOT NULL DEFAULT 0, unresolved_amount_paise INTEGER NOT NULL DEFAULT 0, notified_at TEXT, started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, review_date))`,
  `CREATE TABLE IF NOT EXISTS notification_deliveries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, review_date TEXT NOT NULL, status TEXT NOT NULL, provider_message_id TEXT, attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, review_date))`,
  `CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, metadata TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS mobile_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, device_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_mobile_sessions_user ON mobile_sessions(user_id,revoked_at)`,
  `CREATE TABLE IF NOT EXISTS transaction_tombstones (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, transaction_id TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY(user_id,transaction_id))`,
];

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(schema.map((statement) => db.prepare(statement)));
  schemaReady = true;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...securityHeaders } });
}

const securityHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), geolocation=(), payment=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

function getUser(request) {
  const id = request.headers.get("oai-authenticated-user-id");
  if (!id) return null;
  const email = request.headers.get("oai-authenticated-user-email") || "";
  let name = request.headers.get("oai-authenticated-user-full-name") || "";
  if (name && request.headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8") {
    try { name = decodeURIComponent(name); } catch { name = ""; }
  }
  return { id, email, name: name || email.split("@")[0] || "Paisa user" };
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(size = 32) {
  const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return base64url(bytes);
}

function timestamp(value = new Date()) { return value.toISOString(); }
function laterThan(left, right) { return new Date(left).getTime() > new Date(right).getTime(); }

async function getMobileUser(request, db) {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i); if (!match || match[1].length < 32) return null;
  const tokenHash = await sha256(match[1]);
  const session = await db.prepare("SELECT s.id,s.user_id,u.email,u.display_name FROM mobile_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL").bind(tokenHash).first();
  if (!session) return null;
  await db.prepare("UPDATE mobile_sessions SET last_used_at=CURRENT_TIMESTAMP WHERE id=?").bind(session.id).run();
  return { id: session.user_id, email: session.email || "", name: session.display_name || "Paisa user", sessionId: session.id };
}

function localDate(timezone = "Asia/Kolkata") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function audit(db, userId, action, entityType, entityId = null, metadata = null) {
  await db.prepare("INSERT INTO audit_log (id,user_id,action,entity_type,entity_id,metadata) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(), userId, action, entityType, entityId, metadata ? JSON.stringify(metadata) : null).run();
}

async function upsertUser(db, user) {
  await db.batch([
    db.prepare("INSERT INTO users (id,email,display_name) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,last_seen_at=CURRENT_TIMESTAMP").bind(user.id, user.email, user.name),
    db.prepare("INSERT OR IGNORE INTO reminder_preferences (user_id) VALUES (?)").bind(user.id),
  ]);
}

function mapTransaction(row) {
  return {
    id: row.id,
    merchant: row.merchant,
    description: row.description,
    amountPaise: Number(row.amount_paise),
    amount: Number(row.amount_paise) / 100,
    occurredAt: row.occurred_at,
    category: row.category,
    reviewStatus: row.review_status,
    context: row.context,
    importanceScore: Number(row.importance_score),
    source: row.source,
    updatedAt: timestamp(new Date(String(row.updated_at).replace(" ", "T") + (String(row.updated_at).includes("Z") ? "" : "Z"))),
    isDeleted: false,
  };
}

async function authorizeMobile(env, user, url) {
  const callback = url.searchParams.get("callback");
  const state = String(url.searchParams.get("state") || "").slice(0, 120);
  const deviceName = String(url.searchParams.get("deviceName") || "iPhone").trim().slice(0, 80) || "iPhone";
  if (callback !== "paisa://sync-auth" || state.length < 16) return json({ error: "Invalid mobile authorization request" }, 400);
  if (!env.SITES_BYPASS_TOKEN) return json({ error: "Mobile sync is not configured" }, 503);
  const accessToken = randomToken(48);
  const sessionId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO mobile_sessions (id,user_id,token_hash,device_name) VALUES (?,?,?,?)").bind(sessionId, user.id, await sha256(accessToken), deviceName).run();
  await audit(env.DB, user.id, "mobile.connected", "mobile_session", sessionId, { deviceName });
  const redirect = new URL(callback);
  redirect.searchParams.set("access_token", accessToken);
  redirect.searchParams.set("sites_token", env.SITES_BYPASS_TOKEN);
  redirect.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: redirect.toString(), "cache-control": "no-store", ...securityHeaders } });
}

async function syncMobile(db, user, payload) {
  const incoming = Array.isArray(payload.transactions) ? payload.transactions.slice(0, 2000) : []; const aliases = {};
  for (const item of incoming) {
    const id = String(item.id || "");
    const parsedUpdatedAt = new Date(item.updatedAt || 0);
    if (!/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(parsedUpdatedAt.getTime())) continue;
    const updatedAt = timestamp(parsedUpdatedAt);
    const existing = await db.prepare("SELECT * FROM transactions WHERE id=? AND user_id=?").bind(id, user.id).first();
    if (item.isDeleted) {
      if (!existing || laterThan(updatedAt, existing.updated_at)) {
        await db.batch([
          db.prepare("DELETE FROM transactions WHERE id=? AND user_id=?").bind(id, user.id),
          db.prepare("INSERT INTO transaction_tombstones (user_id,transaction_id,deleted_at) VALUES (?,?,?) ON CONFLICT(user_id,transaction_id) DO UPDATE SET deleted_at=CASE WHEN excluded.deleted_at>deleted_at THEN excluded.deleted_at ELSE deleted_at END").bind(user.id, id, updatedAt),
        ]);
      }
      continue;
    }
    const tombstone = await db.prepare("SELECT deleted_at FROM transaction_tombstones WHERE user_id=? AND transaction_id=?").bind(user.id, id).first();
    if (tombstone && !laterThan(updatedAt, tombstone.deleted_at)) continue;
    const input = transactionInput(item, existing || {}); if (!input) continue;
    const model = { merchant: input.merchant, amountPaise: input.amountPaise, occurredAt: input.occurredAt, categoryConfidence: input.category === "Uncategorised" ? 0 : .75 }; const key = dedupeKey(model);
    if (existing) {
      if (laterThan(updatedAt, existing.updated_at)) await db.prepare("UPDATE transactions SET amount_paise=?,merchant=?,description=?,occurred_at=?,category=?,review_status=?,context=?,importance_score=?,dedupe_key=?,source=?,updated_at=? WHERE id=? AND user_id=?").bind(input.amountPaise, input.merchant, input.description, input.occurredAt, input.category, input.reviewStatus, input.context, importance(model), key, String(item.source || "ios").slice(0, 30), updatedAt, id, user.id).run();
    } else {
      const duplicate = await db.prepare("SELECT id FROM transactions WHERE user_id=? AND dedupe_key=?").bind(user.id, key).first();
      if (duplicate) { aliases[id] = duplicate.id; continue; }
      await db.prepare("INSERT INTO transactions (id,user_id,amount_paise,merchant,description,occurred_at,category,review_status,context,importance_score,dedupe_key,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id, user.id, input.amountPaise, input.merchant, input.description, input.occurredAt, input.category, input.reviewStatus, input.context, importance(model), key, String(item.source || "ios").slice(0, 30), updatedAt, updatedAt).run();
    }
  }
  const [transactions, tombstones] = await Promise.all([
    db.prepare("SELECT * FROM transactions WHERE user_id=? ORDER BY occurred_at DESC LIMIT 2000").bind(user.id).all(),
    db.prepare("SELECT transaction_id,deleted_at FROM transaction_tombstones WHERE user_id=?").bind(user.id).all(),
  ]);
  return json({ serverTime: timestamp(), transactions: transactions.results.map(mapTransaction), tombstones: tombstones.results.map((row) => ({ id: row.transaction_id, deletedAt: timestamp(new Date(String(row.deleted_at).replace(" ", "T") + (String(row.deleted_at).includes("Z") ? "" : "Z"))) })), aliases });
}

async function getPreferences(db, userId) {
  const row = await db.prepare("SELECT * FROM reminder_preferences WHERE user_id=?").bind(userId).first();
  return {
    personality: row?.personality || "Balanced",
    reviewTime: row?.preferred_time || "21:30",
    quietStart: row?.quiet_start || "23:00",
    quietEnd: row?.quiet_end || "07:00",
    importantAmount: String(Number(row?.important_amount_paise || 100000) / 100),
    importantAmountPaise: Number(row?.important_amount_paise || 100000),
    minimumTotalPaise: Number(row?.minimum_total_paise || 30000),
    weeklyCleanup: Boolean(row?.weekly_cleanup ?? 1),
    timezone: row?.timezone || "Asia/Kolkata",
  };
}

async function unresolvedSummary(db, userId) {
  const row = await db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(amount_paise),0) AS amount,COALESCE(MAX(amount_paise),0) AS highest FROM transactions WHERE user_id=? AND review_status='unresolved' AND is_reversed=0 AND is_recurring=0 AND is_own_transfer=0").bind(userId).first();
  return { count: Number(row?.count || 0), amountPaise: Number(row?.amount || 0), highestAmountPaise: Number(row?.highest || 0) };
}

async function bootstrap(db, user) {
  const [queue, preferences, summary, totals] = await Promise.all([
    db.prepare("SELECT * FROM transactions WHERE user_id=? AND review_status='unresolved' AND is_reversed=0 ORDER BY importance_score DESC,occurred_at DESC LIMIT 50").bind(user.id).all(),
    getPreferences(db, user.id), unresolvedSummary(db, user.id),
    db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(amount_paise),0) AS amount FROM transactions WHERE user_id=?").bind(user.id).first(),
  ]);
  const today = localDate(preferences.timezone);
  await db.prepare("INSERT INTO daily_reviews (id,user_id,review_date,state,unresolved_count,unresolved_amount_paise) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,review_date) DO UPDATE SET unresolved_count=excluded.unresolved_count,unresolved_amount_paise=excluded.unresolved_amount_paise,updated_at=CURRENT_TIMESTAMP").bind(crypto.randomUUID(), user.id, today, summary.count ? "scheduled" : "not_required", summary.count, summary.amountPaise).run();
  return { user, transactions: queue.results.map(mapTransaction), preferences, summary, totals: { count: Number(totals?.count || 0), amountPaise: Number(totals?.amount || 0) } };
}

async function importTransactions(db, user, payload) {
  const transactions = Array.isArray(payload.transactions) ? payload.transactions.slice(0, 1000) : [];
  if (!transactions.length) return json({ error: "At least one transaction is required" }, 400);
  let imported = 0;
  for (const input of transactions) {
    const amountPaise = Math.round(Number(input.amount || 0) * 100);
    const occurredAt = new Date(input.occurredAt || input.date || Date.now()).toISOString();
    const merchant = normalizeMerchant(String(input.merchant || input.description || "Unknown payment")).slice(0, 160);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0 || !merchant) continue;
    const transaction = { merchant, amountPaise, occurredAt, categoryConfidence: input.category ? .75 : 0 };
    const result = await db.prepare("INSERT OR IGNORE INTO transactions (id,user_id,amount_paise,merchant,description,occurred_at,category,importance_score,dedupe_key,source) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), user.id, amountPaise, merchant, String(input.description || "").slice(0, 300), occurredAt, String(input.category || "Uncategorised").slice(0, 80), importance(transaction), dedupeKey(transaction), String(payload.source || "csv").slice(0, 30)).run();
    imported += Number(result.meta?.changes || 0);
  }
  await audit(db, user.id, "transactions.imported", "transaction", null, { imported, received: transactions.length });
  return json({ imported, duplicates: transactions.length - imported });
}

function transactionInput(payload, existing = {}) {
  const merchant = normalizeMerchant(String(payload.merchant ?? existing.merchant ?? "")).slice(0, 160);
  const rawAmount = payload.amount ?? (Number(existing.amount_paise || 0) / 100);
  const amountPaise = Math.round(Number(rawAmount) * 100);
  const dateValue = payload.occurredAt ?? payload.date ?? existing.occurred_at ?? new Date().toISOString();
  const parsedDate = new Date(dateValue);
  if (!merchant || !Number.isFinite(amountPaise) || amountPaise <= 0 || Number.isNaN(parsedDate.getTime())) return null;
  const occurredAt = parsedDate.toISOString();
  return {
    merchant,
    amountPaise,
    occurredAt,
    description: String(payload.description ?? existing.description ?? "").slice(0, 300),
    category: String(payload.category ?? existing.category ?? "Uncategorised").slice(0, 80),
    context: String(payload.context ?? existing.context ?? "").slice(0, 1000),
    reviewStatus: ["unresolved", "explained", "known", "deferred", "auto_resolved"].includes(payload.reviewStatus) ? payload.reviewStatus : (existing.review_status || "unresolved"),
  };
}

async function listTransactions(db, user, url) {
  const rows = await db.prepare("SELECT * FROM transactions WHERE user_id=? ORDER BY occurred_at DESC LIMIT 1000").bind(user.id).all();
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const status = url.searchParams.get("status") || "all";
  const category = url.searchParams.get("category") || "all";
  const transactions = rows.results.map(mapTransaction).filter((row) => {
    if (status !== "all" && row.reviewStatus !== status) return false;
    if (category !== "all" && row.category !== category) return false;
    return !search || `${row.merchant} ${row.description || ""} ${row.context || ""}`.toLowerCase().includes(search);
  });
  return json({ transactions, total: transactions.length });
}

async function createTransaction(db, user, payload) {
  const input = transactionInput(payload);
  if (!input) return json({ error: "Merchant, a positive amount, and a valid date are required" }, 400);
  const id = crypto.randomUUID();
  const transaction = { merchant: input.merchant, amountPaise: input.amountPaise, occurredAt: input.occurredAt, categoryConfidence: input.category === "Uncategorised" ? 0 : .75 };
  const result = await db.prepare("INSERT OR IGNORE INTO transactions (id,user_id,amount_paise,merchant,description,occurred_at,category,review_status,context,importance_score,dedupe_key,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(id, user.id, input.amountPaise, input.merchant, input.description, input.occurredAt, input.category, input.reviewStatus, input.context, importance(transaction), dedupeKey(transaction), "manual").run();
  if (!result.meta?.changes) return json({ error: "This transaction already exists" }, 409);
  await audit(db, user.id, "transaction.created", "transaction", id);
  const row = await db.prepare("SELECT * FROM transactions WHERE id=? AND user_id=?").bind(id, user.id).first();
  return json({ transaction: mapTransaction(row) }, 201);
}

async function replaceTransaction(db, user, id, payload) {
  const existing = await db.prepare("SELECT * FROM transactions WHERE id=? AND user_id=?").bind(id, user.id).first();
  if (!existing) return json({ error: "Transaction not found" }, 404);
  const input = transactionInput(payload, existing);
  if (!input) return json({ error: "Merchant, a positive amount, and a valid date are required" }, 400);
  const transaction = { merchant: input.merchant, amountPaise: input.amountPaise, occurredAt: input.occurredAt, categoryConfidence: input.category === "Uncategorised" ? 0 : .75 };
  try {
    await db.prepare("UPDATE transactions SET amount_paise=?,merchant=?,description=?,occurred_at=?,category=?,review_status=?,context=?,importance_score=?,dedupe_key=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").bind(input.amountPaise, input.merchant, input.description, input.occurredAt, input.category, input.reviewStatus, input.context, importance(transaction), dedupeKey(transaction), id, user.id).run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) return json({ error: "This edit would duplicate another transaction" }, 409);
    throw error;
  }
  await audit(db, user.id, "transaction.updated", "transaction", id);
  const row = await db.prepare("SELECT * FROM transactions WHERE id=? AND user_id=?").bind(id, user.id).first();
  return json({ transaction: mapTransaction(row) });
}

async function deleteTransaction(db, user, id) {
  const result = await db.prepare("DELETE FROM transactions WHERE id=? AND user_id=? RETURNING id").bind(id, user.id).first();
  if (!result) return json({ error: "Transaction not found" }, 404);
  await db.prepare("INSERT INTO transaction_tombstones (user_id,transaction_id,deleted_at) VALUES (?,?,?) ON CONFLICT(user_id,transaction_id) DO UPDATE SET deleted_at=excluded.deleted_at").bind(user.id, id, timestamp()).run();
  await audit(db, user.id, "transaction.deleted", "transaction", id);
  return json({ deleted: true });
}

async function getInsights(db, user) {
  const [categories, days, status, totals, largest] = await Promise.all([
    db.prepare("SELECT COALESCE(category,'Uncategorised') AS category,SUM(amount_paise) AS amount,COUNT(*) AS count FROM transactions WHERE user_id=? GROUP BY category ORDER BY amount DESC LIMIT 8").bind(user.id).all(),
    db.prepare("SELECT substr(occurred_at,1,10) AS day,SUM(amount_paise) AS amount FROM transactions WHERE user_id=? GROUP BY day ORDER BY day DESC LIMIT 14").bind(user.id).all(),
    db.prepare("SELECT review_status AS status,COUNT(*) AS count FROM transactions WHERE user_id=? GROUP BY review_status").bind(user.id).all(),
    db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(amount_paise),0) AS amount,COALESCE(AVG(amount_paise),0) AS average FROM transactions WHERE user_id=?").bind(user.id).first(),
    db.prepare("SELECT merchant,amount_paise,category FROM transactions WHERE user_id=? ORDER BY amount_paise DESC LIMIT 1").bind(user.id).first(),
  ]);
  return json({
    categories: categories.results.map((row) => ({ name: row.category, amountPaise: Number(row.amount), count: Number(row.count) })),
    days: days.results.reverse().map((row) => ({ day: row.day, amountPaise: Number(row.amount) })),
    statuses: status.results.map((row) => ({ status: row.status, count: Number(row.count) })),
    totals: { count: Number(totals?.count || 0), amountPaise: Number(totals?.amount || 0), averagePaise: Number(totals?.average || 0) },
    largest: largest ? { merchant: largest.merchant, amountPaise: Number(largest.amount_paise), category: largest.category } : null,
  });
}

async function updateTransaction(db, user, id, payload) {
  const allowed = new Set(["explain", "known", "defer", "auto_resolve"]);
  if (!allowed.has(payload.action)) return json({ error: "Unsupported review action" }, 400);
  const status = { explain: "explained", known: "known", defer: "deferred", auto_resolve: "auto_resolved" }[payload.action];
  const result = await db.prepare("UPDATE transactions SET review_status=?,context=?,category=COALESCE(?,category),is_recurring=CASE WHEN ?='known' THEN 1 ELSE is_recurring END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").bind(status, String(payload.context || "").slice(0, 1000), payload.category || null, payload.action, id, user.id).run();
  if (!result.meta?.changes) return json({ error: "Transaction not found" }, 404);
  await audit(db, user.id, `transaction.${payload.action}`, "transaction", id);
  return json({ id, reviewStatus: status });
}

async function batchExplain(db, user, payload) {
  const text = String(payload.text || "").trim().slice(0, 2000);
  if (!text) return json({ error: "Explanation is required" }, 400);
  const rows = await db.prepare("SELECT id,merchant FROM transactions WHERE user_id=? AND review_status='unresolved'").bind(user.id).all();
  const matched = matchExplanation(text, rows.results);
  if (!matched.length) return json({ matched: [], unmatched: rows.results.map((row) => row.id) });
  const groupId = crypto.randomUUID();
  await db.prepare("INSERT INTO review_groups (id,user_id,title,context) VALUES (?,?,?,?)").bind(groupId, user.id, text.toLowerCase().includes("gurgaon") ? "Gurgaon trip" : "Batch explanation", text).run();
  await db.batch(matched.map((row) => db.prepare("UPDATE transactions SET review_status='explained',context=?,group_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").bind(text, groupId, row.id, user.id)));
  await audit(db, user.id, "review.batch_explained", "review_group", groupId, { count: matched.length });
  return json({ groupId, matched: matched.map((row) => row.id), unmatched: rows.results.filter((row) => !matched.some((item) => item.id === row.id)).map((row) => row.id) });
}

async function savePreferences(db, user, payload) {
  const personality = ["Gentle", "Balanced", "Strict"].includes(payload.personality) ? payload.personality : "Balanced";
  const validTime = (value, fallback) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || "") ? value : fallback;
  const amount = Math.max(100, Math.min(100000, Number(payload.importantAmount || 1000)));
  await db.prepare("UPDATE reminder_preferences SET personality=?,preferred_time=?,quiet_start=?,quiet_end=?,important_amount_paise=?,weekly_cleanup=?,timezone=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?").bind(personality, validTime(payload.reviewTime, "21:30"), validTime(payload.quietStart, "23:00"), validTime(payload.quietEnd, "07:00"), Math.round(amount * 100), payload.weeklyCleanup ? 1 : 0, String(payload.timezone || "Asia/Kolkata").slice(0, 64), user.id).run();
  await audit(db, user.id, "preferences.updated", "reminder_preferences", user.id);
  return json(await getPreferences(db, user.id));
}

async function processReminders(env) {
  const users = await env.DB.prepare("SELECT id FROM users").all();
  let scheduled = 0;
  for (const row of users.results) {
    const preferences = await getPreferences(env.DB, row.id);
    const summary = await unresolvedSummary(env.DB, row.id);
    const today = localDate(preferences.timezone);
    const delivered = await env.DB.prepare("SELECT id FROM notification_deliveries WHERE user_id=? AND review_date=?").bind(row.id, today).first();
    if (!shouldNotify(summary, preferences, Boolean(delivered))) continue;
    const deliveryId = crypto.randomUUID();
    await env.DB.prepare("INSERT OR IGNORE INTO notification_deliveries (id,user_id,review_date,status) VALUES (?,?,?,'scheduled')").bind(deliveryId, row.id, today).run();
    if (env.PUSH_WEBHOOK_URL) {
      const response = await fetch(env.PUSH_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.PUSH_WEBHOOK_SECRET || ""}` }, body: JSON.stringify({ userId: row.id, title: "Review today’s spending", body: `${summary.count} payments need context`, unresolvedAmountPaise: summary.amountPaise }) });
      await env.DB.prepare("UPDATE notification_deliveries SET status=? WHERE id=?").bind(response.ok ? "sent" : "failed", deliveryId).run();
    }
    scheduled++;
  }
  return { scheduled };
}

async function handleApi(request, env, url) {
  if (!env.DB) return json({ error: "Database binding unavailable" }, 503);
  await ensureSchema(env.DB);
  if (request.method === "POST" && url.pathname === "/api/internal/run-reminders") {
    if (!env.INTERNAL_SECRET || request.headers.get("authorization") !== `Bearer ${env.INTERNAL_SECRET}`) return json({ error: "Forbidden" }, 403);
    return json(await processReminders(env));
  }
  if (url.pathname === "/api/mobile/sync" || url.pathname === "/api/mobile/session") {
    const mobileUser = await getMobileUser(request, env.DB); if (!mobileUser) return json({ error: "Mobile authentication required" }, 401);
    if (request.method === "POST" && url.pathname === "/api/mobile/sync") return syncMobile(env.DB, mobileUser, await request.json());
    if (request.method === "DELETE" && url.pathname === "/api/mobile/session") { await env.DB.prepare("UPDATE mobile_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=?").bind(mobileUser.sessionId).run(); return json({ disconnected: true }); }
  }
  const user = getUser(request);
  if (!user) return json({ error: "Authentication required" }, 401);
  await upsertUser(env.DB, user);
  if (request.method === "GET" && url.pathname === "/api/mobile/authorize") return authorizeMobile(env, user, url);
  if (request.method === "GET" && url.pathname === "/api/mobile/devices") { const rows = await env.DB.prepare("SELECT id,device_name,created_at,last_used_at FROM mobile_sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY last_used_at DESC").bind(user.id).all(); return json({ devices: rows.results }); }
  if (request.method === "GET" && url.pathname === "/api/bootstrap") return json(await bootstrap(env.DB, user));
  if (request.method === "GET" && url.pathname === "/api/transactions") return listTransactions(env.DB, user, url);
  if (request.method === "POST" && url.pathname === "/api/transactions") return createTransaction(env.DB, user, await request.json());
  if (request.method === "POST" && url.pathname === "/api/transactions/import") return importTransactions(env.DB, user, await request.json());
  if (request.method === "GET" && url.pathname === "/api/insights") return getInsights(env.DB, user);
  if (request.method === "POST" && url.pathname === "/api/reviews/batch") return batchExplain(env.DB, user, await request.json());
  if (request.method === "PUT" && url.pathname === "/api/preferences") return savePreferences(env.DB, user, await request.json());
  if (request.method === "GET" && url.pathname === "/api/export") {
    const data = await env.DB.prepare("SELECT amount_paise,merchant,description,occurred_at,category,review_status,context,source FROM transactions WHERE user_id=? ORDER BY occurred_at DESC").bind(user.id).all();
    return json({ exportedAt: new Date().toISOString(), user: { email: user.email }, transactions: data.results });
  }
  if (request.method === "DELETE" && url.pathname === "/api/account") {
    await env.DB.prepare("DELETE FROM users WHERE id=?").bind(user.id).run();
    return json({ deleted: true });
  }
  const transactionMatch = url.pathname.match(/^\/api\/transactions\/([^/]+)$/);
  if (request.method === "PATCH" && transactionMatch) return updateTransaction(env.DB, user, transactionMatch[1], await request.json());
  if (request.method === "PUT" && transactionMatch) return replaceTransaction(env.DB, user, transactionMatch[1], await request.json());
  if (request.method === "DELETE" && transactionMatch) return deleteTransaction(env.DB, user, transactionMatch[1]);
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json({ status: "ok", time: new Date().toISOString() });
    if (url.pathname.startsWith("/api/")) {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({ error: "Cross-origin requests are not allowed" }, 403);
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
      try { return await handleApi(request, env, url); } catch (error) { console.error("api_error", error); return json({ error: "Request could not be completed" }, 500); }
    }
    if (!env?.ASSETS) return new Response("Static asset binding unavailable", { status: 500 });
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    Object.entries(securityHeaders).forEach(([key, value]) => headers.set(key, value));
    headers.set("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },
  async scheduled(_event, env, context) {
    context.waitUntil((async () => { await ensureSchema(env.DB); await processReminders(env); })());
  },
};
