import { dedupeKey, explainMatches, importance, normalizeMerchant, shouldNotify } from "./domain.mjs";

const schema = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, display_name TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS reminder_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, personality TEXT NOT NULL DEFAULT 'Balanced', preferred_time TEXT NOT NULL DEFAULT '21:30', quiet_start TEXT NOT NULL DEFAULT '23:00', quiet_end TEXT NOT NULL DEFAULT '07:00', important_amount_paise INTEGER NOT NULL DEFAULT 100000, minimum_total_paise INTEGER NOT NULL DEFAULT 30000, weekly_cleanup INTEGER NOT NULL DEFAULT 1, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS review_groups (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, context TEXT, category TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, amount_paise INTEGER NOT NULL, merchant TEXT NOT NULL, description TEXT, occurred_at TEXT NOT NULL, time_verified INTEGER NOT NULL DEFAULT 0, category TEXT, review_status TEXT NOT NULL DEFAULT 'unresolved', context TEXT, importance_score REAL NOT NULL DEFAULT 0, is_recurring INTEGER NOT NULL DEFAULT 0, is_reversed INTEGER NOT NULL DEFAULT 0, is_own_transfer INTEGER NOT NULL DEFAULT 0, group_id TEXT REFERENCES review_groups(id) ON DELETE SET NULL, dedupe_key TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', account_tag TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, dedupe_key))`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_review_queue ON transactions(user_id, review_status, occurred_at, importance_score DESC)`,
  `CREATE TABLE IF NOT EXISTS daily_reviews (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, review_date TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'scheduled', unresolved_count INTEGER NOT NULL DEFAULT 0, unresolved_amount_paise INTEGER NOT NULL DEFAULT 0, notified_at TEXT, started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, review_date))`,
  `CREATE TABLE IF NOT EXISTS notification_deliveries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, review_date TEXT NOT NULL, status TEXT NOT NULL, provider_message_id TEXT, attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, review_date))`,
  `CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, metadata TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS mobile_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, device_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_mobile_sessions_user ON mobile_sessions(user_id,revoked_at)`,
  `CREATE TABLE IF NOT EXISTS push_devices (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_id TEXT NOT NULL REFERENCES mobile_sessions(id) ON DELETE CASCADE, environment TEXT NOT NULL DEFAULT 'production', app_bundle TEXT NOT NULL DEFAULT 'com.shashankmahajan.paisa', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id,session_id)`,
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

function dateWindow(url, column = "occurred_at") {
  const clauses = [], bindings = [];
  const valid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "") && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
  const from = url?.searchParams.get("from") || ""; const to = url?.searchParams.get("to") || "";
  const requestedOffset = Number(url?.searchParams.get("offset")); const offset = Number.isFinite(requestedOffset) && requestedOffset >= -720 && requestedOffset <= 840 ? requestedOffset : 0;
  const boundary = (value, extraDays = 0) => { const [year, month, day] = value.split("-").map(Number); return new Date(Date.UTC(year, month - 1, day + extraDays) - offset * 60000).toISOString(); };
  if (valid(from)) { clauses.push(`${column}>=?`); bindings.push(boundary(from)); }
  if (valid(to)) { clauses.push(`${column}<?`); bindings.push(boundary(to, 1)); }
  return { clauses, bindings, from: valid(from) ? from : null, to: valid(to) ? to : null };
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
    timeVerified: Boolean(row.time_verified),
    category: row.category,
    reviewStatus: row.review_status,
    context: row.context,
    importanceScore: Number(row.importance_score),
    source: row.source,
    accountTag: row.account_tag || "",
    updatedAt: timestamp(new Date(String(row.updated_at).replace(" ", "T") + (String(row.updated_at).includes("Z") ? "" : "Z"))),
    isDeleted: false,
  };
}

function sourceSet(value = "") { return new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean)); }
function joinedSources(left, right) { return [...new Set([...sourceSet(left), ...sourceSet(right)])].sort().join(","); }
function merchantTokens(value = "") { return new Set(normalizeMerchant(value).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2 && !["upi", "paytm", "payment", "transaction", "debit"].includes(token))); }
function merchantSimilarity(left, right) {
  const a = merchantTokens(left); const b = merchantTokens(right); if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length; return intersection / new Set([...a, ...b]).size;
}
function referenceFrom(value = "") { return String(value).match(/(?:Reference|UTR|UPI ref|transaction id)[:\s-]*([A-Z0-9-]{6,40})/i)?.[1]?.toLowerCase() || ""; }
function combinedAccountTag(left = "", right = "") {
  if (!left) return right; if (!right || left === right) return left;
  const value = `${left} ${right}`; const bank = ["ICICI", "HDFC", "Axis", "SBI", "Kotak", "YES Bank"].find((name) => value.toLowerCase().includes(name.toLowerCase()));
  if (/paytm/i.test(value) && bank) return `Paytm - Savings ${bank}`;
  return [...new Set([left, right])].sort().join(" + ");
}

async function verifiedDuplicate(db, userId, input, source) {
  const date = new Date(input.occurredAt); const start = new Date(date.getTime() - 86400000).toISOString(); const end = new Date(date.getTime() + 86400000).toISOString();
  const rows = await db.prepare("SELECT * FROM transactions WHERE user_id=? AND amount_paise=? AND occurred_at BETWEEN ? AND ?").bind(userId, input.amountPaise, start, end).all();
  const incomingReference = referenceFrom(`${input.description} ${input.context}`);
  return rows.results.find((row) => {
    const existingReference = referenceFrom(`${row.description || ""} ${row.context || ""}`);
    if (incomingReference && existingReference) return incomingReference === existingReference;
    const incomingSources = sourceSet(source); const crossSource = ![...sourceSet(row.source)].some((value) => incomingSources.has(value));
    return crossSource && merchantSimilarity(row.merchant, input.merchant) >= .66;
  });
}

async function mergeVerifiedDuplicate(db, userId, row, input, source) {
  const accountTag = combinedAccountTag(row.account_tag || "", input.accountTag || "");
  const verification = accountTag ? `Verified in ${accountTag}` : "Verified across statements";
  const incomingSources = sourceSet(source); const crossSource = ![...sourceSet(row.source)].some((value) => incomingSources.has(value));
  const context = !crossSource || String(row.context || "").includes(verification) ? String(row.context || "") : [row.context, verification].filter(Boolean).join(" · ");
  const occurredAt = input.timeVerified && !row.time_verified ? input.occurredAt : row.occurred_at;
  const timeVerified = Boolean(row.time_verified) || input.timeVerified;
  await db.prepare("UPDATE transactions SET source=?,account_tag=?,context=?,occurred_at=?,time_verified=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").bind(joinedSources(row.source, source), accountTag, context.slice(0, 1000), occurredAt, timeVerified ? 1 : 0, row.id, userId).run();
  return row.id;
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
      if (laterThan(updatedAt, existing.updated_at)) await db.prepare("UPDATE transactions SET amount_paise=?,merchant=?,description=?,occurred_at=?,time_verified=?,category=?,review_status=?,context=?,importance_score=?,dedupe_key=?,source=?,account_tag=?,updated_at=? WHERE id=? AND user_id=?").bind(input.amountPaise, input.merchant, input.description, input.occurredAt, input.timeVerified ? 1 : 0, input.category, input.reviewStatus, input.context, importance(model), key, String(item.source || "ios").slice(0, 120), input.accountTag, updatedAt, id, user.id).run();
    } else {
      const source = String(item.source || "ios").slice(0, 120);
      const duplicate = await db.prepare("SELECT * FROM transactions WHERE user_id=? AND dedupe_key=?").bind(user.id, key).first();
      if (duplicate) { aliases[id] = await mergeVerifiedDuplicate(db, user.id, duplicate, input, source); continue; }
      const verified = await verifiedDuplicate(db, user.id, input, source);
      if (verified) { aliases[id] = await mergeVerifiedDuplicate(db, user.id, verified, input, source); continue; }
      await db.prepare("INSERT INTO transactions (id,user_id,amount_paise,merchant,description,occurred_at,time_verified,category,review_status,context,importance_score,dedupe_key,source,account_tag,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id, user.id, input.amountPaise, input.merchant, input.description, input.occurredAt, input.timeVerified ? 1 : 0, input.category, input.reviewStatus, input.context, importance(model), key, source, input.accountTag, updatedAt, updatedAt).run();
    }
  }
  const [transactions, tombstones] = await Promise.all([
    db.prepare("SELECT * FROM transactions WHERE user_id=? ORDER BY occurred_at DESC LIMIT 2000").bind(user.id).all(),
    db.prepare("SELECT transaction_id,deleted_at FROM transaction_tombstones WHERE user_id=?").bind(user.id).all(),
  ]);
  const preferences = await getPreferences(db, user.id);
  return json({ serverTime: timestamp(), transactions: transactions.results.map(mapTransaction), tombstones: tombstones.results.map((row) => ({ id: row.transaction_id, deletedAt: timestamp(new Date(String(row.deleted_at).replace(" ", "T") + (String(row.deleted_at).includes("Z") ? "" : "Z"))) })), aliases, preferences });
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

async function unresolvedSummary(db, userId, window = { clauses: [], bindings: [] }) {
  const predicate = ["user_id=?", "review_status='unresolved'", "is_reversed=0", "is_recurring=0", "is_own_transfer=0", ...window.clauses].join(" AND ");
  const row = await db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(amount_paise),0) AS amount,COALESCE(MAX(amount_paise),0) AS highest FROM transactions WHERE ${predicate}`).bind(userId, ...window.bindings).first();
  return { count: Number(row?.count || 0), amountPaise: Number(row?.amount || 0), highestAmountPaise: Number(row?.highest || 0) };
}

async function bootstrap(db, user, url) {
  const window = dateWindow(url); const windowPredicate = window.clauses.length ? ` AND ${window.clauses.join(" AND ")}` : "";
  const [queue, preferences, summary, totals, allSummary] = await Promise.all([
    db.prepare(`SELECT * FROM transactions WHERE user_id=? AND review_status='unresolved' AND is_reversed=0${windowPredicate} ORDER BY importance_score DESC,occurred_at DESC LIMIT 2000`).bind(user.id, ...window.bindings).all(),
    getPreferences(db, user.id), unresolvedSummary(db, user.id, window),
    db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(amount_paise),0) AS amount FROM transactions WHERE user_id=?${windowPredicate}`).bind(user.id, ...window.bindings).first(),
    unresolvedSummary(db, user.id),
  ]);
  const today = localDate(preferences.timezone);
  await db.prepare("INSERT INTO daily_reviews (id,user_id,review_date,state,unresolved_count,unresolved_amount_paise) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,review_date) DO UPDATE SET unresolved_count=excluded.unresolved_count,unresolved_amount_paise=excluded.unresolved_amount_paise,updated_at=CURRENT_TIMESTAMP").bind(crypto.randomUUID(), user.id, today, allSummary.count ? "scheduled" : "not_required", allSummary.count, allSummary.amountPaise).run();
  return { user, transactions: queue.results.map(mapTransaction), preferences, summary, totals: { count: Number(totals?.count || 0), amountPaise: Number(totals?.amount || 0) }, window: { from: window.from, to: window.to } };
}

async function importTransactions(db, user, payload) {
  const transactions = Array.isArray(payload.transactions) ? payload.transactions.slice(0, 1000) : [];
  if (!transactions.length) return json({ error: "At least one transaction is required" }, 400);
  let imported = 0, verified = 0, duplicates = 0;
  for (const item of transactions) {
    const input = transactionInput(item); if (!input) continue;
    const source = String(item.source || payload.source || "csv").slice(0, 120);
    const transaction = { merchant: input.merchant, amountPaise: input.amountPaise, occurredAt: input.occurredAt, categoryConfidence: input.category ? .75 : 0 };
    const matched = await verifiedDuplicate(db, user.id, input, source);
    if (matched) {
      const incomingSources = sourceSet(source); const crossSource = ![...sourceSet(matched.source)].some((value) => incomingSources.has(value));
      await mergeVerifiedDuplicate(db, user.id, matched, input, source); if (crossSource) verified++; else duplicates++; continue;
    }
    const result = await db.prepare("INSERT OR IGNORE INTO transactions (id,user_id,amount_paise,merchant,description,occurred_at,time_verified,category,importance_score,dedupe_key,source,account_tag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), user.id, input.amountPaise, input.merchant, input.description, input.occurredAt, input.timeVerified ? 1 : 0, input.category, importance(transaction), dedupeKey(transaction), source, input.accountTag).run();
    imported += Number(result.meta?.changes || 0);
    if (!result.meta?.changes) duplicates++;
  }
  await audit(db, user.id, "transactions.imported", "transaction", null, { imported, verified, duplicates, received: transactions.length });
  return json({ imported, verified, duplicates });
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
    timeVerified: typeof payload.timeVerified === "boolean" ? payload.timeVerified : Boolean(existing.time_verified),
    description: String(payload.description ?? existing.description ?? "").slice(0, 300),
    category: String(payload.category ?? existing.category ?? "Uncategorised").slice(0, 80),
    context: String(payload.context ?? existing.context ?? "").slice(0, 1000),
    reviewStatus: ["unresolved", "explained", "known", "deferred", "auto_resolved"].includes(payload.reviewStatus) ? payload.reviewStatus : (existing.review_status || "unresolved"),
    accountTag: String(payload.accountTag ?? existing.account_tag ?? "").slice(0, 100),
  };
}

async function listTransactions(db, user, url) {
  const search = (url.searchParams.get("search") || "").trim().toLowerCase().slice(0, 120);
  const status = url.searchParams.get("status") || "all";
  const category = String(url.searchParams.get("category") || "all").slice(0, 80);
  const page = Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const pageSize = Math.max(10, Math.min(50, Number.parseInt(url.searchParams.get("pageSize") || "25", 10) || 25));
  const where = ["user_id=?"]; const bindings = [user.id];
  if (["unresolved", "explained", "known", "deferred", "auto_resolved"].includes(status)) { where.push("review_status=?"); bindings.push(status); }
  if (category !== "all") { where.push("COALESCE(category,'Uncategorised')=?"); bindings.push(category); }
  if (search) {
    const escaped = search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    where.push("LOWER(merchant || ' ' || COALESCE(description,'') || ' ' || COALESCE(context,'') || ' ' || COALESCE(account_tag,'')) LIKE ? ESCAPE '\\'");
    bindings.push(`%${escaped}%`);
  }
  const window = dateWindow(url); where.push(...window.clauses); bindings.push(...window.bindings);
  const predicate = where.join(" AND "); const offset = (page - 1) * pageSize;
  const [rows, summary, categories] = await Promise.all([
    db.prepare(`SELECT * FROM transactions WHERE ${predicate} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`).bind(...bindings, pageSize, offset).all(),
    db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(amount_paise),0) AS amount FROM transactions WHERE ${predicate}`).bind(...bindings).first(),
    db.prepare("SELECT DISTINCT COALESCE(category,'Uncategorised') AS category FROM transactions WHERE user_id=? ORDER BY category").bind(user.id).all(),
  ]);
  const total = Number(summary?.count || 0);
  return json({ transactions: rows.results.map(mapTransaction), total, totalAmountPaise: Number(summary?.amount || 0), page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), categories: categories.results.map((row) => row.category).filter(Boolean) });
}

async function createTransaction(db, user, payload) {
  const input = transactionInput(payload);
  if (!input) return json({ error: "Merchant, a positive amount, and a valid date are required" }, 400);
  const id = crypto.randomUUID();
  const transaction = { merchant: input.merchant, amountPaise: input.amountPaise, occurredAt: input.occurredAt, categoryConfidence: input.category === "Uncategorised" ? 0 : .75 };
  const result = await db.prepare("INSERT OR IGNORE INTO transactions (id,user_id,amount_paise,merchant,description,occurred_at,time_verified,category,review_status,context,importance_score,dedupe_key,source,account_tag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id, user.id, input.amountPaise, input.merchant, input.description, input.occurredAt, input.timeVerified ? 1 : 0, input.category, input.reviewStatus, input.context, importance(transaction), dedupeKey(transaction), "manual", input.accountTag).run();
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
    await db.prepare("UPDATE transactions SET amount_paise=?,merchant=?,description=?,occurred_at=?,time_verified=?,category=?,review_status=?,context=?,importance_score=?,dedupe_key=?,account_tag=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").bind(input.amountPaise, input.merchant, input.description, input.occurredAt, input.timeVerified ? 1 : 0, input.category, input.reviewStatus, input.context, importance(transaction), dedupeKey(transaction), input.accountTag, id, user.id).run();
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

async function getInsights(db, user, url) {
  const window = dateWindow(url); const predicate = ["user_id=?", ...window.clauses].join(" AND "); const bindings = [user.id, ...window.bindings];
  const [categories, days, status, totals, largest] = await Promise.all([
    db.prepare(`SELECT COALESCE(category,'Uncategorised') AS category,SUM(amount_paise) AS amount,COUNT(*) AS count FROM transactions WHERE ${predicate} GROUP BY category ORDER BY amount DESC LIMIT 8`).bind(...bindings).all(),
    db.prepare(`SELECT substr(occurred_at,1,10) AS day,SUM(amount_paise) AS amount FROM transactions WHERE ${predicate} GROUP BY day ORDER BY day DESC LIMIT 366`).bind(...bindings).all(),
    db.prepare(`SELECT review_status AS status,COUNT(*) AS count FROM transactions WHERE ${predicate} GROUP BY review_status`).bind(...bindings).all(),
    db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(amount_paise),0) AS amount,COALESCE(AVG(amount_paise),0) AS average FROM transactions WHERE ${predicate}`).bind(...bindings).first(),
    db.prepare(`SELECT merchant,amount_paise,category FROM transactions WHERE ${predicate} ORDER BY amount_paise DESC LIMIT 1`).bind(...bindings).first(),
  ]);
  return json({
    categories: categories.results.map((row) => ({ name: row.category, amountPaise: Number(row.amount), count: Number(row.count) })),
    days: days.results.reverse().map((row) => ({ day: row.day, amountPaise: Number(row.amount) })),
    statuses: status.results.map((row) => ({ status: row.status, count: Number(row.count) })),
    totals: { count: Number(totals?.count || 0), amountPaise: Number(totals?.amount || 0), averagePaise: Number(totals?.average || 0) },
    largest: largest ? { merchant: largest.merchant, amountPaise: Number(largest.amount_paise), category: largest.category } : null, window: { from: window.from, to: window.to },
  });
}

async function resetFinancialData(db, user) {
  const rows = await db.prepare("SELECT id FROM transactions WHERE user_id=?").bind(user.id).all(); const deletedAt = timestamp();
  const tombstones = rows.results.map((row) => db.prepare("INSERT INTO transaction_tombstones (user_id,transaction_id,deleted_at) VALUES (?,?,?) ON CONFLICT(user_id,transaction_id) DO UPDATE SET deleted_at=excluded.deleted_at").bind(user.id, row.id, deletedAt));
  if (tombstones.length) await db.batch(tombstones);
  await db.batch([
    db.prepare("DELETE FROM transactions WHERE user_id=?").bind(user.id),
    db.prepare("DELETE FROM review_groups WHERE user_id=?").bind(user.id),
    db.prepare("DELETE FROM daily_reviews WHERE user_id=?").bind(user.id),
    db.prepare("DELETE FROM notification_deliveries WHERE user_id=?").bind(user.id),
  ]);
  await audit(db, user.id, "financial_data.reset", "transaction", null, { deleted: rows.results.length });
  return json({ reset: true, deleted: rows.results.length });
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
  const rows = await db.prepare("SELECT id,merchant,description,amount_paise,category FROM transactions WHERE user_id=? AND review_status='unresolved'").bind(user.id).all();
  const decisions = explainMatches(text, rows.results);
  if (!decisions.length) return json({ matched: [], unmatched: rows.results.map((row) => row.id), categories: {} });
  const groupId = crypto.randomUUID();
  await db.prepare("INSERT INTO review_groups (id,user_id,title,context) VALUES (?,?,?,?)").bind(groupId, user.id, text.toLowerCase().includes("gurgaon") ? "Gurgaon trip" : "Batch explanation", text).run();
  await db.batch(decisions.map(({ transaction, category }) => db.prepare("UPDATE transactions SET review_status='explained',context=?,category=COALESCE(?,category),group_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").bind(text, category, groupId, transaction.id, user.id)));
  const matchedIds = new Set(decisions.map(({ transaction }) => transaction.id));
  const categories = Object.fromEntries(decisions.filter(({ category }) => category).map(({ transaction, category }) => [transaction.id, category]));
  await audit(db, user.id, "review.batch_explained", "review_group", groupId, { count: decisions.length, categories });
  return json({ groupId, matched: [...matchedIds], unmatched: rows.results.filter((row) => !matchedIds.has(row.id)).map((row) => row.id), categories });
}

async function savePreferences(db, user, payload) {
  const personality = ["Gentle", "Balanced", "Strict"].includes(payload.personality) ? payload.personality : "Balanced";
  const validTime = (value, fallback) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || "") ? value : fallback;
  const amount = Math.max(100, Math.min(100000, Number(payload.importantAmount || 1000)));
  await db.prepare("UPDATE reminder_preferences SET personality=?,preferred_time=?,quiet_start=?,quiet_end=?,important_amount_paise=?,weekly_cleanup=?,timezone=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?").bind(personality, validTime(payload.reviewTime, "21:30"), validTime(payload.quietStart, "23:00"), validTime(payload.quietEnd, "07:00"), Math.round(amount * 100), payload.weeklyCleanup ? 1 : 0, String(payload.timezone || "Asia/Kolkata").slice(0, 64), user.id).run();
  await audit(db, user.id, "preferences.updated", "reminder_preferences", user.id);
  return json(await getPreferences(db, user.id));
}

async function savePushDevice(db, user, payload) {
  const token = String(payload.token || "").toLowerCase();
  const environment = payload.environment === "sandbox" ? "sandbox" : "production";
  if (!/^[0-9a-f]{64,200}$/.test(token)) return json({ error: "Invalid APNs device token" }, 400);
  await db.prepare("INSERT INTO push_devices (token,user_id,session_id,environment) VALUES (?,?,?,?) ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id,session_id=excluded.session_id,environment=excluded.environment,updated_at=CURRENT_TIMESTAMP").bind(token, user.id, user.sessionId, environment).run();
  await audit(db, user.id, "push.registered", "mobile_session", user.sessionId, { environment });
  return json({ registered: true });
}

async function deletePushDevice(db, user, payload = {}) {
  const token = String(payload?.token || "").toLowerCase();
  if (token) await db.prepare("DELETE FROM push_devices WHERE user_id=? AND token=?").bind(user.id, token).run();
  else await db.prepare("DELETE FROM push_devices WHERE user_id=? AND session_id=?").bind(user.id, user.sessionId).run();
  return json({ deleted: true });
}

let apnsAuthCache = null;
function pemBytes(value) {
  const body = String(value || "").replaceAll("\\n", "\n").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(body); return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
async function apnsAuthorization(env) {
  if (!env.APNS_TEAM_ID || !env.APNS_KEY_ID || !env.APNS_PRIVATE_KEY) throw new Error("APNs credentials are not configured");
  const now = Math.floor(Date.now() / 1000);
  if (apnsAuthCache && now - apnsAuthCache.createdAt < 3000) return apnsAuthCache.value;
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID })));
  const claims = base64url(new TextEncoder().encode(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now })));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(env.APNS_PRIVATE_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned)));
  const value = `bearer ${unsigned}.${base64url(signature)}`; apnsAuthCache = { createdAt: now, value }; return value;
}

async function sendAPNs(env, device, summary) {
  const authorization = await apnsAuthorization(env);
  const host = device.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const body = summary.count === 1 ? "One payment needs a little context." : `${summary.count} payments need a little context.`;
  const response = await fetch(`${host}/3/device/${device.token}`, {
    method: "POST",
    headers: {
      authorization,
      "apns-topic": env.APNS_TOPIC || device.app_bundle || "com.shashankmahajan.paisa",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify({ aps: { alert: { title: "Your Paisa inbox is ready", body }, sound: "default", badge: summary.count, category: "DAILY_REVIEW" }, route: "review" }),
  });
  if (response.status === 410 || response.status === 400) {
    const reason = await response.json().catch(() => ({}));
    if (["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(reason.reason)) return { ok: false, remove: true, reason: reason.reason };
  }
  return { ok: response.ok, remove: false, reason: response.ok ? "sent" : `http_${response.status}` };
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
    const devices = await env.DB.prepare("SELECT token,environment,app_bundle FROM push_devices WHERE user_id=?").bind(row.id).all();
    let sent = 0, failed = 0;
    for (const device of devices.results) {
      try {
        const result = await sendAPNs(env, device, summary);
        if (result.ok) sent++; else failed++;
        if (result.remove) await env.DB.prepare("DELETE FROM push_devices WHERE token=?").bind(device.token).run();
      } catch { failed++; }
    }
    if (!sent && env.PUSH_WEBHOOK_URL) {
      const response = await fetch(env.PUSH_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.PUSH_WEBHOOK_SECRET || ""}` }, body: JSON.stringify({ userId: row.id, title: "Review today’s spending", body: `${summary.count} payments need context`, unresolvedAmountPaise: summary.amountPaise }) });
      if (response.ok) sent++ ; else failed++;
    }
    await env.DB.prepare("UPDATE notification_deliveries SET status=?,provider_message_id=? WHERE id=?").bind(sent ? "sent" : (failed ? "failed" : "no_device"), `apns:${sent};failed:${failed}`, deliveryId).run();
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
  if (["/api/mobile/sync", "/api/mobile/session", "/api/mobile/push-token"].includes(url.pathname)) {
    const mobileUser = await getMobileUser(request, env.DB); if (!mobileUser) return json({ error: "Mobile authentication required" }, 401);
    if (request.method === "POST" && url.pathname === "/api/mobile/sync") return syncMobile(env.DB, mobileUser, await request.json());
    if (request.method === "POST" && url.pathname === "/api/mobile/push-token") return savePushDevice(env.DB, mobileUser, await request.json());
    if (request.method === "DELETE" && url.pathname === "/api/mobile/push-token") return deletePushDevice(env.DB, mobileUser, await request.json().catch(() => ({})));
    if (request.method === "DELETE" && url.pathname === "/api/mobile/session") { await env.DB.batch([env.DB.prepare("DELETE FROM push_devices WHERE session_id=?").bind(mobileUser.sessionId), env.DB.prepare("UPDATE mobile_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=?").bind(mobileUser.sessionId)]); return json({ disconnected: true }); }
  }
  const user = getUser(request);
  if (!user) return json({ error: "Authentication required" }, 401);
  await upsertUser(env.DB, user);
  if (request.method === "GET" && url.pathname === "/api/mobile/authorize") return authorizeMobile(env, user, url);
  if (request.method === "GET" && url.pathname === "/api/mobile/devices") { const rows = await env.DB.prepare("SELECT id,device_name,created_at,last_used_at FROM mobile_sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY last_used_at DESC").bind(user.id).all(); return json({ devices: rows.results }); }
  if (request.method === "GET" && url.pathname === "/api/bootstrap") return json(await bootstrap(env.DB, user, url));
  if (request.method === "GET" && url.pathname === "/api/transactions") return listTransactions(env.DB, user, url);
  if (request.method === "DELETE" && url.pathname === "/api/transactions") return resetFinancialData(env.DB, user);
  if (request.method === "POST" && url.pathname === "/api/transactions") return createTransaction(env.DB, user, await request.json());
  if (request.method === "POST" && url.pathname === "/api/transactions/import") return importTransactions(env.DB, user, await request.json());
  if (request.method === "GET" && url.pathname === "/api/insights") return getInsights(env.DB, user, url);
  if (request.method === "POST" && url.pathname === "/api/reviews/batch") return batchExplain(env.DB, user, await request.json());
  if (request.method === "PUT" && url.pathname === "/api/preferences") return savePreferences(env.DB, user, await request.json());
  if (request.method === "GET" && url.pathname === "/api/export") {
    const data = await env.DB.prepare("SELECT amount_paise,merchant,description,occurred_at,time_verified,category,review_status,context,source,account_tag FROM transactions WHERE user_id=? ORDER BY occurred_at DESC").bind(user.id).all();
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
