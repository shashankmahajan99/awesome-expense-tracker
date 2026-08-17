import { dedupeKey, duplicateEvidence, explainMatches, importance, normalizeMerchant, shouldNotify } from "./domain.mjs";
import { buildConsentRequest, extractDepositTransactions, normalizeIndianMobile, publicConsent } from "./setu-aa.mjs";

const schema = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, display_name TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS reminder_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, personality TEXT NOT NULL DEFAULT 'Balanced', preferred_time TEXT NOT NULL DEFAULT '21:30', quiet_start TEXT NOT NULL DEFAULT '23:00', quiet_end TEXT NOT NULL DEFAULT '07:00', important_amount_paise INTEGER NOT NULL DEFAULT 100000, minimum_total_paise INTEGER NOT NULL DEFAULT 30000, weekly_cleanup INTEGER NOT NULL DEFAULT 1, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS review_groups (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, context TEXT, category TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, amount_paise INTEGER NOT NULL, merchant TEXT NOT NULL, description TEXT, occurred_at TEXT NOT NULL, time_verified INTEGER NOT NULL DEFAULT 0, category TEXT, review_status TEXT NOT NULL DEFAULT 'unresolved', context TEXT, importance_score REAL NOT NULL DEFAULT 0, is_recurring INTEGER NOT NULL DEFAULT 0, is_reversed INTEGER NOT NULL DEFAULT 0, is_own_transfer INTEGER NOT NULL DEFAULT 0, group_id TEXT REFERENCES review_groups(id) ON DELETE SET NULL, dedupe_key TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', account_tag TEXT NOT NULL DEFAULT '', loan_id TEXT REFERENCES loans(id) ON DELETE SET NULL, emi_number INTEGER, principal_component_paise INTEGER NOT NULL DEFAULT 0, interest_component_paise INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, dedupe_key))`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_review_queue ON transactions(user_id, review_status, occurred_at, importance_score DESC)`,
  `CREATE TABLE IF NOT EXISTS payment_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'bank', institution TEXT NOT NULL DEFAULT '', last_four TEXT NOT NULL DEFAULT '', aliases TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id,name))`,
  `CREATE INDEX IF NOT EXISTS idx_payment_accounts_user_kind ON payment_accounts(user_id,kind,name)`,
  `CREATE TABLE IF NOT EXISTS loans (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, lender TEXT NOT NULL DEFAULT '', loan_type TEXT NOT NULL DEFAULT 'personal', account_number TEXT NOT NULL DEFAULT '', principal_paise INTEGER NOT NULL DEFAULT 0, outstanding_paise INTEGER NOT NULL DEFAULT 0, interest_rate_bps INTEGER NOT NULL DEFAULT 0, tenure_months INTEGER NOT NULL DEFAULT 0, emi_amount_paise INTEGER NOT NULL DEFAULT 0, start_date TEXT, next_due_date TEXT, status TEXT NOT NULL DEFAULT 'active', no_cost_emi INTEGER NOT NULL DEFAULT 0, total_interest_paise INTEGER NOT NULL DEFAULT 0, processing_fee_paise INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id,name))`,
  `CREATE INDEX IF NOT EXISTS idx_loans_user_status ON loans(user_id,status,next_due_date)`,
  `CREATE TABLE IF NOT EXISTS daily_reviews (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, review_date TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'scheduled', unresolved_count INTEGER NOT NULL DEFAULT 0, unresolved_amount_paise INTEGER NOT NULL DEFAULT 0, notified_at TEXT, started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, review_date))`,
  `CREATE TABLE IF NOT EXISTS notification_deliveries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, review_date TEXT NOT NULL, status TEXT NOT NULL, provider_message_id TEXT, attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, review_date))`,
  `CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, metadata TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS mobile_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, device_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_mobile_sessions_user ON mobile_sessions(user_id,revoked_at)`,
  `CREATE TABLE IF NOT EXISTS push_devices (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_id TEXT NOT NULL REFERENCES mobile_sessions(id) ON DELETE CASCADE, environment TEXT NOT NULL DEFAULT 'production', app_bundle TEXT NOT NULL DEFAULT 'com.shashankmahajan.paisa', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id,session_id)`,
  `CREATE TABLE IF NOT EXISTS transaction_tombstones (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, transaction_id TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY(user_id,transaction_id))`,
  `CREATE TABLE IF NOT EXISTS aa_consents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL DEFAULT 'setu', consent_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'PENDING', consent_url TEXT NOT NULL DEFAULT '', mobile_last_four TEXT NOT NULL DEFAULT '', purpose_code TEXT NOT NULL DEFAULT '102', data_range_from TEXT NOT NULL, data_range_to TEXT NOT NULL, consent_expires_at TEXT, accounts_json TEXT NOT NULL DEFAULT '[]', last_synced_at TEXT, last_error_code TEXT NOT NULL DEFAULT '', last_error_message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_aa_consents_user_status ON aa_consents(user_id,status,updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS aa_events (event_id TEXT PRIMARY KEY, consent_id TEXT NOT NULL, event_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT '', received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_aa_events_consent_received ON aa_events(consent_id,received_at DESC)`,
  `CREATE TABLE IF NOT EXISTS aa_transaction_refs (provider TEXT NOT NULL, external_ref TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, consent_id TEXT NOT NULL, transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(provider,external_ref,user_id))`,
  `CREATE TABLE IF NOT EXISTS monthly_money_plans (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, month TEXT NOT NULL, income_paise INTEGER NOT NULL DEFAULT 0, planned_savings_paise INTEGER NOT NULL DEFAULT 0, fixed_costs_paise INTEGER NOT NULL DEFAULT 0, intention TEXT NOT NULL DEFAULT '', reflection TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,month))`,
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

let setuTokenCache = null;
function setuConfig(env) {
  const production = env.SETU_ENV === "production";
  return {
    configured: Boolean(env.SETU_CLIENT_ID && env.SETU_CLIENT_SECRET && env.SETU_PRODUCT_INSTANCE_ID && env.SETU_WEBHOOK_SECRET),
    baseUrl: env.SETU_BASE_URL || (production ? "https://fiu.setu.co" : "https://fiu-sandbox.setu.co"),
    authUrl: env.SETU_AUTH_URL || (production ? "https://prod.setu.co/api/v2/auth/token" : "https://uat.setu.co/api/v2/auth/token"),
  };
}

async function setuAccessToken(env, refresh = false) {
  if (!setuConfig(env).configured) throw new Error("Setu AA is not configured");
  if (!refresh && setuTokenCache && setuTokenCache.expiresAt > Date.now() + 60000) return setuTokenCache.token;
  const response = await fetch(setuConfig(env).authUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientID: env.SETU_CLIENT_ID, secret: env.SETU_CLIENT_SECRET }) });
  const result = await response.json().catch(() => ({}));
  const token = result?.data?.token || result?.token;
  const expiresIn = Number(result?.data?.expiresIn || result?.expiresIn || 1800);
  if (!response.ok || !token) throw new Error("Setu authentication failed");
  setuTokenCache = { token, expiresAt: Date.now() + Math.max(60, expiresIn) * 1000 };
  return token;
}

async function setuRequest(env, path, options = {}, retry = true) {
  const token = await setuAccessToken(env);
  const response = await fetch(`${setuConfig(env).baseUrl}${path}`, { ...options, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-product-instance-id": env.SETU_PRODUCT_INSTANCE_ID, ...(options.headers || {}) } });
  if (response.status === 401 && retry) { await setuAccessToken(env, true); return setuRequest(env, path, options, false); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(result.errorMsg || result.message || result.error?.message || `Setu request failed (${response.status})`).slice(0, 240));
  return result;
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

function mapPaymentAccount(row) { return { id: row.id, name: row.name, kind: row.kind, institution: row.institution || "", lastFour: row.last_four || "", aliases: JSON.parse(row.aliases || "[]"), updatedAt: timestamp(new Date(String(row.updated_at).replace(" ", "T") + (String(row.updated_at).includes("Z") ? "" : "Z"))) }; }

async function listPaymentAccounts(db, userId) {
  await db.prepare("INSERT OR IGNORE INTO payment_accounts (id,user_id,name,kind,institution) SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),user_id,account_tag,CASE WHEN lower(account_tag) LIKE '%card%' THEN 'card' WHEN lower(account_tag) LIKE '%paytm%' OR lower(account_tag) LIKE '%wallet%' THEN 'wallet' ELSE 'bank' END,CASE WHEN lower(account_tag) LIKE '%icici%' THEN 'ICICI' WHEN lower(account_tag) LIKE '%hdfc%' THEN 'HDFC' WHEN lower(account_tag) LIKE '%axis%' THEN 'Axis' WHEN lower(account_tag) LIKE '%sbi%' THEN 'SBI' ELSE '' END FROM transactions WHERE user_id=? AND trim(account_tag)<>'' GROUP BY user_id,account_tag").bind(userId).run();
  const rows = await db.prepare("SELECT * FROM payment_accounts WHERE user_id=? ORDER BY kind,name").bind(userId).all(); return rows.results.map(mapPaymentAccount);
}

async function savePaymentAccount(db, user, payload) {
  const name = String(payload.name || "").trim().slice(0, 100); const kind = ["bank", "card", "wallet", "app", "cash", "other"].includes(payload.kind) ? payload.kind : "bank";
  const institution = String(payload.institution || "").trim().slice(0, 80), lastFour = String(payload.lastFour || "").replace(/\D/g, "").slice(-4);
  const aliases = [...new Set((Array.isArray(payload.aliases) ? payload.aliases : []).map((value) => String(value).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  if (!name) return json({ error: "Account name is required" }, 400);
  const requestedId = /^[0-9a-f-]{36}$/i.test(String(payload.id || "")) ? String(payload.id) : null;
  const existing = requestedId ? await db.prepare("SELECT id,name FROM payment_accounts WHERE user_id=? AND id=?").bind(user.id, requestedId).first() : await db.prepare("SELECT id,name FROM payment_accounts WHERE user_id=? AND lower(name)=lower(?)").bind(user.id, name).first(); const id = existing?.id || crypto.randomUUID();
  if(requestedId){const conflicting=await db.prepare("SELECT id FROM payment_accounts WHERE user_id=? AND lower(name)=lower(?) AND id<>?").bind(user.id,name,id).first();if(conflicting)return json({error:"A payment method with this name already exists"},409);}
  await db.prepare("INSERT INTO payment_accounts (id,user_id,name,kind,institution,last_four,aliases) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,institution=excluded.institution,last_four=excluded.last_four,aliases=excluded.aliases,updated_at=CURRENT_TIMESTAMP").bind(id, user.id, name, kind, institution, lastFour, JSON.stringify(aliases)).run();
  if(existing?.name&&existing.name!==name)await db.prepare("UPDATE transactions SET account_tag=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND account_tag=?").bind(name,user.id,existing.name).run();
  await audit(db, user.id, existing ? "payment_account.updated" : "payment_account.created", "payment_account", id); const row = await db.prepare("SELECT * FROM payment_accounts WHERE id=? AND user_id=?").bind(id, user.id).first(); return json({ account: mapPaymentAccount(row) }, existing ? 200 : 201);
}

function moneyPaise(value) { const number = Number(value || 0); return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) : 0; }
function safeDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : null; }
function mapLoan(row) { const principalPaise=Number(row.principal_paise||0),principalPaidPaise=Number(row.principal_paid_paise||0),storedOutstanding=Number(row.outstanding_paise||0);return { id: row.id, name: row.name, lender: row.lender || "", loanType: row.loan_type, accountNumber: row.account_number || "", principalPaise, outstandingPaise: storedOutstanding||Math.max(0,principalPaise-principalPaidPaise), principalPaidPaise, interestPaidPaise:Number(row.interest_paid_paise||0), linkedEmiCount:Number(row.linked_emi_count||0), interestRate: Number(row.interest_rate_bps || 0) / 100, tenureMonths: Number(row.tenure_months || 0), emiAmountPaise: Number(row.emi_amount_paise || 0), startDate: row.start_date, nextDueDate: row.next_due_date, status: row.status, noCostEmi: Boolean(row.no_cost_emi), totalInterestPaise: Number(row.total_interest_paise || 0), processingFeePaise: Number(row.processing_fee_paise || 0), source: row.source || "manual", updatedAt: timestamp(new Date(String(row.updated_at).replace(" ", "T") + (String(row.updated_at).includes("Z") ? "" : "Z"))) }; }
async function listLoans(db, userId) { const rows = await db.prepare("SELECT l.*,COUNT(t.id) AS linked_emi_count,COALESCE(SUM(t.principal_component_paise),0) AS principal_paid_paise,COALESCE(SUM(t.interest_component_paise),0) AS interest_paid_paise FROM loans l LEFT JOIN transactions t ON t.loan_id=l.id AND t.user_id=l.user_id WHERE l.user_id=? GROUP BY l.id ORDER BY CASE l.status WHEN 'active' THEN 0 ELSE 1 END,l.next_due_date,l.name").bind(userId).all(); return rows.results.map(mapLoan); }
async function saveLoan(db, user, payload) {
  const name = String(payload.name || "").trim().slice(0, 120), lender = String(payload.lender || "").trim().slice(0, 100); if (!name) return json({ error: "Loan name is required" }, 400);
  const requestedId = /^[0-9a-f-]{36}$/i.test(String(payload.id || "")) ? String(payload.id) : null; const named = requestedId ? null : await db.prepare("SELECT id FROM loans WHERE user_id=? AND lower(name)=lower(?)").bind(user.id,name).first(); const id = requestedId || named?.id || crypto.randomUUID(); const loanType = ["personal","home","vehicle","education","consumer","credit_card","other"].includes(payload.loanType) ? payload.loanType : "personal"; const status = ["active","closed","paused"].includes(payload.status) ? payload.status : "active"; const noCost = Boolean(payload.noCostEmi); const interestRateBps = noCost ? 0 : Math.max(0, Math.min(100000, Math.round(Number(payload.interestRate || 0) * 100)));
  const existing = await db.prepare("SELECT id FROM loans WHERE id=? AND user_id=?").bind(id, user.id).first();
  await db.prepare("INSERT INTO loans (id,user_id,name,lender,loan_type,account_number,principal_paise,outstanding_paise,interest_rate_bps,tenure_months,emi_amount_paise,start_date,next_due_date,status,no_cost_emi,total_interest_paise,processing_fee_paise,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,lender=excluded.lender,loan_type=excluded.loan_type,account_number=excluded.account_number,principal_paise=excluded.principal_paise,outstanding_paise=excluded.outstanding_paise,interest_rate_bps=excluded.interest_rate_bps,tenure_months=excluded.tenure_months,emi_amount_paise=excluded.emi_amount_paise,start_date=excluded.start_date,next_due_date=excluded.next_due_date,status=excluded.status,no_cost_emi=excluded.no_cost_emi,total_interest_paise=excluded.total_interest_paise,processing_fee_paise=excluded.processing_fee_paise,source=excluded.source,updated_at=CURRENT_TIMESTAMP").bind(id,user.id,name,lender,loanType,String(payload.accountNumber || "").trim().slice(-40),moneyPaise(payload.principal),moneyPaise(payload.outstanding),interestRateBps,Math.max(0,Math.min(1200,Number.parseInt(payload.tenureMonths || "0",10)||0)),moneyPaise(payload.emiAmount),safeDate(payload.startDate),safeDate(payload.nextDueDate),status,noCost?1:0,noCost?0:moneyPaise(payload.totalInterest),moneyPaise(payload.processingFee),String(payload.source || "manual").slice(0,80)).run();
  await audit(db,user.id,existing?"loan.updated":"loan.created","loan",id); const row=await db.prepare("SELECT * FROM loans WHERE id=? AND user_id=?").bind(id,user.id).first(); return json({loan:mapLoan(row)},existing?200:201);
}
async function deleteLoan(db,user,id){const linked=await db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE user_id=? AND loan_id=?").bind(user.id,id).first();if(Number(linked?.count||0))return json({error:"Unlink this loan from its EMI transactions before deleting it"},409);const result=await db.prepare("DELETE FROM loans WHERE id=? AND user_id=?").bind(id,user.id).run();if(!result.meta?.changes)return json({error:"Loan not found"},404);return json({deleted:true});}

async function deletePaymentAccount(db, user, id) {
  const row = await db.prepare("SELECT name FROM payment_accounts WHERE id=? AND user_id=?").bind(id, user.id).first(); if (!row) return json({ error: "Payment account not found" }, 404);
  const used = await db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE user_id=? AND account_tag=?").bind(user.id, row.name).first(); if (Number(used?.count || 0)) return json({ error: "Move transactions to another account before deleting this one" }, 409);
  await db.prepare("DELETE FROM payment_accounts WHERE id=? AND user_id=?").bind(id, user.id).run(); return json({ deleted: true });
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
    loanId: row.loan_id || "",
    emiNumber: row.emi_number == null ? null : Number(row.emi_number),
    principalComponentPaise: Number(row.principal_component_paise || 0),
    interestComponentPaise: Number(row.interest_component_paise || 0),
    updatedAt: timestamp(new Date(String(row.updated_at).replace(" ", "T") + (String(row.updated_at).includes("Z") ? "" : "Z"))),
    isDeleted: false,
  };
}

function sourceSet(value = "") { return new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean)); }
function joinedSources(left, right) { return [...new Set([...sourceSet(left), ...sourceSet(right)])].sort().join(","); }
function combinedAccountTag(left = "", right = "") {
  if (!left) return right; if (!right || left === right) return left;
  const value = `${left} ${right}`; const bank = ["ICICI", "HDFC", "Axis", "SBI", "Kotak", "YES Bank"].find((name) => value.toLowerCase().includes(name.toLowerCase()));
  if (/paytm/i.test(value) && bank) return `Paytm - Savings ${bank}`;
  return [...new Set([left, right])].sort().join(" + ");
}

async function verifiedDuplicate(db, userId, input, source) {
  const date = new Date(input.occurredAt); const start = new Date(date.getTime() - 86400000).toISOString(); const end = new Date(date.getTime() + 86400000).toISOString();
  const rows = await db.prepare("SELECT * FROM transactions WHERE user_id=? AND amount_paise=? AND occurred_at BETWEEN ? AND ?").bind(userId, input.amountPaise, start, end).all();
  return rows.results.find((row) => duplicateEvidence(row,input,source));
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

async function reconcileUserDuplicates(db,userId,aliases={}){
  const rows=(await db.prepare("SELECT * FROM transactions WHERE user_id=? ORDER BY occurred_at DESC,created_at DESC LIMIT 2000").bind(userId).all()).results;
  const groups=new Map();for(const row of rows){const key=`${row.amount_paise}|${String(row.occurred_at).slice(0,10)}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  const active=new Set(rows.map((row)=>row.id));let merged=0;
  const score=(row)=>(row.time_verified?4:0)+(String(row.context||"").length?1:0)+(row.category&&String(row.category).toLowerCase()!=="uncategorised"?1:0)+sourceSet(row.source).size;
  const inputFrom=(row)=>({amountPaise:Number(row.amount_paise),merchant:row.merchant,description:row.description||"",context:row.context||"",occurredAt:row.occurred_at,timeVerified:Boolean(row.time_verified),accountTag:row.account_tag||""});
  for(const group of groups.values()){
    for(let left=0;left<group.length;left++)for(let right=left+1;right<group.length;right++){
      if(merged>=100)return merged;const a=group[left],b=group[right];if(!active.has(a.id)||!active.has(b.id))continue;
      if(!duplicateEvidence(a,inputFrom(b),b.source))continue;
      const survivor=score(a)>=score(b)?a:b,duplicate=survivor===a?b:a,incoming=inputFrom(duplicate);
      await mergeVerifiedDuplicate(db,userId,survivor,incoming,duplicate.source);
      const deletedAt=timestamp();await db.batch([db.prepare("DELETE FROM transactions WHERE id=? AND user_id=?").bind(duplicate.id,userId),db.prepare("INSERT INTO transaction_tombstones (user_id,transaction_id,deleted_at) VALUES (?,?,?) ON CONFLICT(user_id,transaction_id) DO UPDATE SET deleted_at=excluded.deleted_at").bind(userId,duplicate.id,deletedAt)]);
      aliases[duplicate.id]=survivor.id;active.delete(duplicate.id);survivor.source=joinedSources(survivor.source,duplicate.source);survivor.account_tag=combinedAccountTag(survivor.account_tag||"",duplicate.account_tag||"");survivor.time_verified=survivor.time_verified||duplicate.time_verified;merged++;
    }
  }
  return merged;
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
  for (const account of (Array.isArray(payload.accounts) ? payload.accounts.slice(0, 200) : [])) {
    const id = String(account.id || ""), name = String(account.name || "").trim().slice(0, 100); if (!/^[0-9a-f-]{36}$/i.test(id) || !name) continue;
    const kind = ["bank", "card", "wallet", "app", "cash", "other"].includes(account.kind) ? account.kind : "bank"; const institution = String(account.institution || "").slice(0, 80), lastFour = String(account.lastFour || "").replace(/\D/g, "").slice(-4), accountAliases = JSON.stringify(Array.isArray(account.aliases) ? account.aliases.slice(0, 20) : []);
    const named = await db.prepare("SELECT id FROM payment_accounts WHERE user_id=? AND lower(name)=lower(?)").bind(user.id, name).first();
    if (named) await db.prepare("UPDATE payment_accounts SET kind=?,institution=?,last_four=?,aliases=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").bind(kind, institution, lastFour, accountAliases, named.id, user.id).run();
    else await db.prepare("INSERT INTO payment_accounts (id,user_id,name,kind,institution,last_four,aliases) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,institution=excluded.institution,last_four=excluded.last_four,aliases=excluded.aliases,updated_at=CURRENT_TIMESTAMP").bind(id, user.id, name, kind, institution, lastFour, accountAliases).run();
  }
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
  await reconcileUserDuplicates(db,user.id,aliases);
  const duplicatesMerged = Object.keys(aliases).length;
  if (duplicatesMerged) await audit(db,user.id,"transactions.deduplicated","transaction",null,{ merged: duplicatesMerged, source: "mobile_sync" });
  const [transactions, tombstones] = await Promise.all([
    db.prepare("SELECT * FROM transactions WHERE user_id=? ORDER BY occurred_at DESC LIMIT 2000").bind(user.id).all(),
    db.prepare("SELECT transaction_id,deleted_at FROM transaction_tombstones WHERE user_id=?").bind(user.id).all(),
  ]);
  const preferences = await getPreferences(db, user.id);
  return json({ serverTime: timestamp(), transactions: transactions.results.map(mapTransaction), accounts: await listPaymentAccounts(db, user.id), tombstones: tombstones.results.map((row) => ({ id: row.transaction_id, deletedAt: timestamp(new Date(String(row.deleted_at).replace(" ", "T") + (String(row.deleted_at).includes("Z") ? "" : "Z"))) })), aliases, duplicatesMerged, preferences });
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
  const [queue, preferences, summary, totals, allSummary, accounts, loans] = await Promise.all([
    db.prepare(`SELECT * FROM transactions WHERE user_id=? AND review_status='unresolved' AND is_reversed=0${windowPredicate} ORDER BY importance_score DESC,occurred_at DESC LIMIT 2000`).bind(user.id, ...window.bindings).all(),
    getPreferences(db, user.id), unresolvedSummary(db, user.id, window),
    db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(amount_paise),0) AS amount FROM transactions WHERE user_id=?${windowPredicate}`).bind(user.id, ...window.bindings).first(),
    unresolvedSummary(db, user.id), listPaymentAccounts(db, user.id), listLoans(db,user.id),
  ]);
  const today = localDate(preferences.timezone);
  await db.prepare("INSERT INTO daily_reviews (id,user_id,review_date,state,unresolved_count,unresolved_amount_paise) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,review_date) DO UPDATE SET unresolved_count=excluded.unresolved_count,unresolved_amount_paise=excluded.unresolved_amount_paise,updated_at=CURRENT_TIMESTAMP").bind(crypto.randomUUID(), user.id, today, allSummary.count ? "scheduled" : "not_required", allSummary.count, allSummary.amountPaise).run();
  return { user, transactions: queue.results.map(mapTransaction), accounts, loans, preferences, summary, totals: { count: Number(totals?.count || 0), amountPaise: Number(totals?.amount || 0) }, window: { from: window.from, to: window.to } };
}

async function importTransactions(db, user, payload) {
  const transactions = Array.isArray(payload.transactions) ? payload.transactions.slice(0, 1000) : [];
  if (!transactions.length) return json({ error: "At least one transaction is required" }, 400);
  const savedAccounts = new Set((await listPaymentAccounts(db, user.id)).map((account) => account.name));
  if (transactions.some((item) => !item.accountTag || !savedAccounts.has(String(item.accountTag)))) return json({ error: "Choose a saved payment account for every statement before importing" }, 400);
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
  const reconciled = await reconcileUserDuplicates(db,user.id,{});
  duplicates += reconciled;
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
  const rawDescription=String(payload.description ?? existing.description ?? "").slice(0,300);const reference=String(payload.reference||"").replace(/[^A-Za-z0-9-]/g,"").slice(0,40);const description=reference&&!rawDescription.toLowerCase().includes(reference.toLowerCase())?`${rawDescription}${rawDescription?" · ":""}Reference: ${reference}`.slice(0,300):rawDescription;
  return {
    merchant,
    amountPaise,
    occurredAt,
    timeVerified: typeof payload.timeVerified === "boolean" ? payload.timeVerified : Boolean(existing.time_verified),
    description,
    category: String(payload.category ?? existing.category ?? "Uncategorised").slice(0, 80),
    context: String(payload.context ?? existing.context ?? "").slice(0, 1000),
    reviewStatus: ["unresolved", "explained", "known", "deferred", "auto_resolved"].includes(payload.reviewStatus) ? payload.reviewStatus : (existing.review_status || "unresolved"),
    accountTag: String(payload.accountTag ?? existing.account_tag ?? "").slice(0, 100),
    loanId: /^[0-9a-f-]{36}$/i.test(String(payload.loanId ?? existing.loan_id ?? "")) ? String(payload.loanId ?? existing.loan_id) : "",
    emiNumber: Math.max(0, Number.parseInt(payload.emiNumber ?? existing.emi_number ?? "0", 10) || 0) || null,
    principalComponentPaise: moneyPaise(payload.principalComponent ?? (Number(existing.principal_component_paise || 0) / 100)),
    interestComponentPaise: moneyPaise(payload.interestComponent ?? (Number(existing.interest_component_paise || 0) / 100)),
  };
}

async function invalidLoanAllocation(db,user,input){if(input.principalComponentPaise+input.interestComponentPaise>input.amountPaise)return "Principal and interest components cannot exceed the payment amount";if(!input.loanId)return null;const loan=await db.prepare("SELECT id FROM loans WHERE id=? AND user_id=?").bind(input.loanId,user.id).first();return loan?null:"Choose a loan that belongs to this account";}

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
  const loanError=await invalidLoanAllocation(db,user,input);if(loanError)return json({error:loanError},400);
  const id = crypto.randomUUID();
  const transaction = { merchant: input.merchant, amountPaise: input.amountPaise, occurredAt: input.occurredAt, categoryConfidence: input.category === "Uncategorised" ? 0 : .75 };
  const result = await db.prepare("INSERT OR IGNORE INTO transactions (id,user_id,amount_paise,merchant,description,occurred_at,time_verified,category,review_status,context,importance_score,dedupe_key,source,account_tag,loan_id,emi_number,principal_component_paise,interest_component_paise) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id, user.id, input.amountPaise, input.merchant, input.description, input.occurredAt, input.timeVerified ? 1 : 0, input.category, input.reviewStatus, input.context, importance(transaction), dedupeKey(transaction), "manual", input.accountTag,input.loanId||null,input.emiNumber,input.principalComponentPaise,input.interestComponentPaise).run();
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
  const loanError=await invalidLoanAllocation(db,user,input);if(loanError)return json({error:loanError},400);
  const transaction = { merchant: input.merchant, amountPaise: input.amountPaise, occurredAt: input.occurredAt, categoryConfidence: input.category === "Uncategorised" ? 0 : .75 };
  try {
    await db.prepare("UPDATE transactions SET amount_paise=?,merchant=?,description=?,occurred_at=?,time_verified=?,category=?,review_status=?,context=?,importance_score=?,dedupe_key=?,account_tag=?,loan_id=?,emi_number=?,principal_component_paise=?,interest_component_paise=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").bind(input.amountPaise, input.merchant, input.description, input.occurredAt, input.timeVerified ? 1 : 0, input.category, input.reviewStatus, input.context, importance(transaction), dedupeKey(transaction), input.accountTag,input.loanId||null,input.emiNumber,input.principalComponentPaise,input.interestComponentPaise,id,user.id).run();
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

async function deleteTransactions(db, user, payload) {
  const ids = [...new Set((Array.isArray(payload.ids) ? payload.ids : []).map(String).filter((id) => /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 500);
  if (!ids.length) return json({ error: "Select at least one transaction" }, 400);
  const deletedAt = timestamp(); let deleted = 0;
  for (const id of ids) {
    const result = await db.prepare("DELETE FROM transactions WHERE id=? AND user_id=? RETURNING id").bind(id, user.id).first();
    if (!result) continue;
    await db.prepare("INSERT INTO transaction_tombstones (user_id,transaction_id,deleted_at) VALUES (?,?,?) ON CONFLICT(user_id,transaction_id) DO UPDATE SET deleted_at=excluded.deleted_at").bind(user.id, id, deletedAt).run();
    deleted++;
  }
  await audit(db, user.id, "transaction.bulk_deleted", "transaction", null, { deleted });
  return json({ deleted });
}

async function setTransactionCategory(db, user, id, payload) {
  const category = String(payload.category || "").trim().slice(0, 80);
  if (!category) return json({ error: "Category is required" }, 400);
  const result = await db.prepare("UPDATE transactions SET category=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").bind(category, id, user.id).run();
  if (!result.meta?.changes) return json({ error: "Transaction not found" }, 404);
  await audit(db, user.id, "transaction.categorised", "transaction", id, { category });
  return json({ id, category });
}

async function getInsights(db, user, url) {
  const window = dateWindow(url); const predicate = ["user_id=?", ...window.clauses].join(" AND "); const bindings = [user.id, ...window.bindings];
  const [categories, days, status, totals, largest, accounts] = await Promise.all([
    db.prepare(`SELECT COALESCE(category,'Uncategorised') AS category,SUM(amount_paise) AS amount,COUNT(*) AS count FROM transactions WHERE ${predicate} GROUP BY category ORDER BY amount DESC LIMIT 8`).bind(...bindings).all(),
    db.prepare(`SELECT substr(occurred_at,1,10) AS day,SUM(amount_paise) AS amount FROM transactions WHERE ${predicate} GROUP BY day ORDER BY day DESC LIMIT 366`).bind(...bindings).all(),
    db.prepare(`SELECT review_status AS status,COUNT(*) AS count FROM transactions WHERE ${predicate} GROUP BY review_status`).bind(...bindings).all(),
    db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(amount_paise),0) AS amount,COALESCE(AVG(amount_paise),0) AS average FROM transactions WHERE ${predicate}`).bind(...bindings).first(),
    db.prepare(`SELECT merchant,amount_paise,category FROM transactions WHERE ${predicate} ORDER BY amount_paise DESC LIMIT 1`).bind(...bindings).first(),
    db.prepare(`SELECT CASE WHEN trim(account_tag)='' THEN 'No account' ELSE account_tag END AS name,SUM(amount_paise) AS amount,COUNT(*) AS count FROM transactions WHERE ${predicate} GROUP BY account_tag ORDER BY amount DESC LIMIT 12`).bind(...bindings).all(),
  ]);
  return json({
    categories: categories.results.map((row) => ({ name: row.category, amountPaise: Number(row.amount), count: Number(row.count) })),
    days: days.results.reverse().map((row) => ({ day: row.day, amountPaise: Number(row.amount) })),
    statuses: status.results.map((row) => ({ status: row.status, count: Number(row.count) })),
    totals: { count: Number(totals?.count || 0), amountPaise: Number(totals?.amount || 0), averagePaise: Number(totals?.average || 0) },
    largest: largest ? { merchant: largest.merchant, amountPaise: Number(largest.amount_paise), category: largest.category } : null, accounts: accounts.results.map((row) => ({ name: row.name, amountPaise: Number(row.amount), count: Number(row.count) })), window: { from: window.from, to: window.to },
  });
}

async function resetFinancialData(db, user) {
  const activeConsent = await db.prepare("SELECT id FROM aa_consents WHERE user_id=? AND status IN ('ACTIVE','PENDING','INITIATED','PAUSED') LIMIT 1").bind(user.id).first();
  if (activeConsent) return json({ error: "Disconnect your bank consent before deleting synced transactions, otherwise the next sync could restore them.", code: "ACTIVE_BANK_CONSENT" }, 409);
  const rows = await db.prepare("SELECT id FROM transactions WHERE user_id=?").bind(user.id).all(); const deletedAt = timestamp();
  const tombstones = rows.results.map((row) => db.prepare("INSERT INTO transaction_tombstones (user_id,transaction_id,deleted_at) VALUES (?,?,?) ON CONFLICT(user_id,transaction_id) DO UPDATE SET deleted_at=excluded.deleted_at").bind(user.id, row.id, deletedAt));
  if (tombstones.length) await db.batch(tombstones);
  await db.batch([
    db.prepare("DELETE FROM transactions WHERE user_id=?").bind(user.id),
    db.prepare("DELETE FROM review_groups WHERE user_id=?").bind(user.id),
    db.prepare("DELETE FROM daily_reviews WHERE user_id=?").bind(user.id),
    db.prepare("DELETE FROM notification_deliveries WHERE user_id=?").bind(user.id),
    db.prepare("DELETE FROM loans WHERE user_id=?").bind(user.id),
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
  const requestedCategory = String(payload.category || "").trim().slice(0, 80);
  const decisions = explainMatches(text, rows.results).map((decision) => ({ ...decision, category: requestedCategory || decision.category }));
  if (!decisions.length) return json({ matched: [], unmatched: rows.results.map((row) => row.id), categories: {} });
  const groupId = crypto.randomUUID();
  await db.prepare("INSERT INTO review_groups (id,user_id,title,context,category) VALUES (?,?,?,?,?)").bind(groupId, user.id, text.toLowerCase().includes("gurgaon") ? "Gurgaon trip" : "Batch explanation", text, requestedCategory || null).run();
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
    body: JSON.stringify({ aps: { alert: { title: "Your Paisa Inbox is ready", body }, sound: "default", badge: summary.count, category: "DAILY_REVIEW" }, route: "review" }),
  });
  if (response.status === 410 || response.status === 400) {
    const reason = await response.json().catch(() => ({}));
    if (["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(reason.reason)) return { ok: false, remove: true, reason: reason.reason };
  }
  return { ok: response.ok, remove: false, reason: response.ok ? "sent" : `http_${response.status}` };
}

async function listBankConnections(db, userId) {
  const rows = await db.prepare("SELECT * FROM aa_consents WHERE user_id=? ORDER BY updated_at DESC").bind(userId).all();
  return rows.results.map(publicConsent);
}

async function createSetuConsent(env, user, request, payload) {
  const config = setuConfig(env);
  if (!config.configured) return json({ error: "Bank connection is being prepared. Setu credentials and webhook verification must be configured before it can go live.", code: "SETU_NOT_CONFIGURED" }, 503);
  const mobile = normalizeIndianMobile(payload.mobile);
  if (!mobile) return json({ error: "Enter a valid 10-digit Indian mobile number" }, 400);
  const existing = await env.DB.prepare("SELECT id FROM aa_consents WHERE user_id=? AND status IN ('ACTIVE','PENDING','INITIATED','PAUSED') ORDER BY updated_at DESC LIMIT 1").bind(user.id).first();
  if (existing) return json({ error: "You already have a current bank consent. Open it to continue, refresh, or revoke it.", existingId: existing.id }, 409);
  const redirectUrl = payload.platform === "ios"
    ? new URL("/setu-return", request.url).toString()
    : new URL("/accounts?setu=returned", request.url).toString();
  const consentRequest = buildConsentRequest({ mobile, redirectUrl });
  let result;
  try { result = await setuRequest(env, "/v2/consents", { method: "POST", body: JSON.stringify(consentRequest) }); }
  catch (error) { return json({ error: error.message || "Setu could not start the consent flow" }, 502); }
  const consentId = String(result.id || result.consentId || "");
  const consentUrl = String(result.url || "");
  if (!consentId || !consentUrl) return json({ error: "Setu returned an incomplete consent response" }, 502);
  const id = crypto.randomUUID();
  const status = String(result.status || "PENDING").toUpperCase();
  const expiry = result.detail?.consentExpiry || null;
  await env.DB.prepare("INSERT INTO aa_consents (id,user_id,consent_id,status,consent_url,mobile_last_four,data_range_from,data_range_to,consent_expires_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(id, user.id, consentId, status, consentUrl, mobile.slice(-4), consentRequest.dataRange.from, consentRequest.dataRange.to, expiry).run();
  await audit(env.DB, user.id, "aa.consent.created", "aa_consent", id, { provider: "setu", purposeCode: "102", status });
  const row = await env.DB.prepare("SELECT * FROM aa_consents WHERE id=?").bind(id).first();
  return json({ connection: publicConsent(row), consentUrl }, 201);
}

async function deleteUserAccount(env, user) {
  const consents = await env.DB.prepare("SELECT id FROM aa_consents WHERE user_id=? AND status IN ('ACTIVE','PENDING','INITIATED','PAUSED')").bind(user.id).all();
  if (consents.results.length && !setuConfig(env).configured) return json({ error: "Bank consent must be revoked before this account can be deleted. Setu is temporarily unavailable; try again later.", code: "CONSENT_REVOCATION_REQUIRED" }, 503);
  for (const consent of consents.results) {
    const response = await revokeSetuConsent(env, user, consent.id);
    if (!response.ok) return response;
  }
  await env.DB.prepare("DELETE FROM users WHERE id=?").bind(user.id).run();
  return json({ deleted: true });
}

async function refreshSetuConsent(env, user, id) {
  const row = await env.DB.prepare("SELECT * FROM aa_consents WHERE id=? AND user_id=?").bind(id, user.id).first();
  if (!row) return json({ error: "Bank consent not found" }, 404);
  if (!setuConfig(env).configured) return json({ error: "Setu AA is not configured" }, 503);
  let result;
  try { result = await setuRequest(env, `/v2/consents/${encodeURIComponent(row.consent_id)}?expanded=true`, { method: "GET" }); }
  catch (error) { return json({ error: error.message || "Could not refresh consent" }, 502); }
  const status = String(result.status || row.status).toUpperCase();
  const accounts = (Array.isArray(result.accountsLinked) ? result.accountsLinked : []).map((account) => ({ maskedAccNumber: account.maskedAccNumber || "", accType: account.accType || "", fipId: account.fipId || account.fipID || "" }));
  await env.DB.prepare("UPDATE aa_consents SET status=?,consent_url=?,accounts_json=?,consent_expires_at=COALESCE(?,consent_expires_at),last_error_code='',last_error_message='',updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").bind(status, status === "PENDING" || status === "INITIATED" ? String(result.url || row.consent_url) : "", JSON.stringify(accounts), result.detail?.consentExpiry || null, id, user.id).run();
  const updated = await env.DB.prepare("SELECT * FROM aa_consents WHERE id=?").bind(id).first();
  return json({ connection: publicConsent(updated) });
}

async function revokeSetuConsent(env, user, id) {
  const row = await env.DB.prepare("SELECT * FROM aa_consents WHERE id=? AND user_id=?").bind(id, user.id).first();
  if (!row) return json({ error: "Bank consent not found" }, 404);
  if (["REVOKED", "EXPIRED", "REJECTED"].includes(String(row.status).toUpperCase())) return json({ connection: publicConsent(row) });
  if (!setuConfig(env).configured) return json({ error: "Setu AA is not configured" }, 503);
  try { await setuRequest(env, `/v2/consents/${encodeURIComponent(row.consent_id)}/revoke`, { method: "POST" }); }
  catch (error) { return json({ error: error.message || "Setu could not revoke consent" }, 502); }
  await env.DB.prepare("UPDATE aa_consents SET status='REVOKED',consent_url='',updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").bind(id, user.id).run();
  await audit(env.DB, user.id, "aa.consent.revoked", "aa_consent", id, { provider: "setu" });
  const updated = await env.DB.prepare("SELECT * FROM aa_consents WHERE id=?").bind(id).first();
  return json({ connection: publicConsent(updated) });
}

function currentMonth() { return new Date().toISOString().slice(0, 7); }
function validMonth(value) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || "")) ? String(value) : currentMonth(); }
async function getMoneyPlan(db, user, monthValue) {
  const month = validMonth(monthValue); const start = `${month}-01T00:00:00.000Z`; const next = new Date(`${start}`); next.setUTCMonth(next.getUTCMonth() + 1);
  const [row, spending] = await Promise.all([db.prepare("SELECT * FROM monthly_money_plans WHERE user_id=? AND month=?").bind(user.id, month).first(), db.prepare("SELECT COALESCE(SUM(amount_paise),0) AS amount FROM transactions WHERE user_id=? AND occurred_at>=? AND occurred_at<? AND is_own_transfer=0 AND is_reversed=0").bind(user.id, start, next.toISOString()).first()]);
  const plan = row || { income_paise: 0, planned_savings_paise: 0, fixed_costs_paise: 0, intention: "", reflection: "" };
  const availablePaise = Math.max(0, Number(plan.income_paise) - Number(plan.planned_savings_paise) - Number(plan.fixed_costs_paise));
  return { month, incomePaise: Number(plan.income_paise), plannedSavingsPaise: Number(plan.planned_savings_paise), fixedCostsPaise: Number(plan.fixed_costs_paise), availablePaise, spentPaise: Number(spending?.amount || 0), remainingPaise: availablePaise - Number(spending?.amount || 0), intention: plan.intention || "", reflection: plan.reflection || "" };
}

async function saveMoneyPlan(db, user, payload) {
  const month = validMonth(payload.month); const paise = (value) => Math.max(0, Math.min(100000000000, Math.round(Number(value || 0) * 100)));
  const intention = String(payload.intention || "").trim().slice(0, 240), reflection = String(payload.reflection || "").trim().slice(0, 1000);
  await db.prepare("INSERT INTO monthly_money_plans (user_id,month,income_paise,planned_savings_paise,fixed_costs_paise,intention,reflection) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,month) DO UPDATE SET income_paise=excluded.income_paise,planned_savings_paise=excluded.planned_savings_paise,fixed_costs_paise=excluded.fixed_costs_paise,intention=excluded.intention,reflection=excluded.reflection,updated_at=CURRENT_TIMESTAMP").bind(user.id, month, paise(payload.income), paise(payload.plannedSavings), paise(payload.fixedCosts), intention, reflection).run();
  await audit(db, user.id, "money_plan.updated", "monthly_money_plan", month);
  return json({ plan: await getMoneyPlan(db, user, month) });
}

function timingSafeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || "")), b = new TextEncoder().encode(String(right || ""));
  let mismatch = a.length ^ b.length; const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) mismatch |= (a[index % Math.max(a.length, 1)] || 0) ^ (b[index % Math.max(b.length, 1)] || 0);
  return mismatch === 0;
}

async function hmacBase64(value, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...signature));
}

async function verifySetuWebhook(request, env, rawBody) {
  if (!env.SETU_WEBHOOK_SECRET) return false;
  const providedSignature = request.headers.get("x-setu-signature");
  if (providedSignature && timingSafeEqual(providedSignature, await hmacBase64(rawBody, env.SETU_WEBHOOK_SECRET))) return true;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const explicit = request.headers.get("x-setu-webhook-secret");
  // Setu Bridge's AA sandbox configuration currently accepts a callback URL
  // but does not expose custom notification headers. Keep a scoped URL token
  // as the sandbox-compatible fallback while preferring signed/header auth.
  const callbackToken = new URL(request.url).searchParams.get("token");
  return timingSafeEqual(bearer || explicit || callbackToken || "", env.SETU_WEBHOOK_SECRET);
}

async function ingestSetuData(db, connection, payload) {
  let imported = 0, merged = 0;
  for (const input of extractDepositTransactions(payload).slice(0, 5000)) {
    const seen = await db.prepare("SELECT transaction_id FROM aa_transaction_refs WHERE provider='setu' AND external_ref=? AND user_id=?").bind(input.externalRef, connection.user_id).first();
    if (seen) continue;
    const duplicate = await verifiedDuplicate(db, connection.user_id, { ...input, timeVerified: true }, "setu-aa");
    let transactionId;
    if (duplicate) { transactionId = await mergeVerifiedDuplicate(db, connection.user_id, duplicate, { ...input, timeVerified: true }, "setu-aa"); merged++; }
    else {
      const id = crypto.randomUUID(); const model = { ...input, timeVerified: true, categoryConfidence: 0 };
      const result = await db.prepare("INSERT OR IGNORE INTO transactions (id,user_id,amount_paise,merchant,description,occurred_at,time_verified,importance_score,dedupe_key,source,account_tag) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(id, connection.user_id, input.amountPaise, input.merchant, input.description, input.occurredAt, 1, importance(model), dedupeKey(model), "setu-aa", input.accountTag).run();
      transactionId = result.meta?.changes ? id : (await db.prepare("SELECT id FROM transactions WHERE user_id=? AND dedupe_key=?").bind(connection.user_id, dedupeKey(model)).first())?.id;
      if (result.meta?.changes) imported++; else if (transactionId) merged++;
    }
    if (transactionId) await db.prepare("INSERT OR IGNORE INTO aa_transaction_refs (provider,external_ref,user_id,consent_id,transaction_id) VALUES ('setu',?,?,?,?)").bind(input.externalRef, connection.user_id, connection.consent_id, transactionId).run();
  }
  await db.prepare("UPDATE aa_consents SET last_synced_at=CURRENT_TIMESTAMP,last_error_code='',last_error_message='',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(connection.id).run();
  return { imported, merged };
}

async function handleSetuWebhook(request, env) {
  if (!env.DB) return json({ error: "Database binding unavailable" }, 503);
  await ensureSchema(env.DB);
  const rawBody = await request.text();
  if (!(await verifySetuWebhook(request, env, rawBody))) return json({ error: "Invalid webhook signature" }, 401);
  let payload; try { payload = JSON.parse(rawBody); } catch { return json({ error: "Invalid JSON" }, 400); }
  const consentId = String(payload.consentId || ""); if (!consentId) return json({ error: "consentId is required" }, 400);
  const connection = await env.DB.prepare("SELECT * FROM aa_consents WHERE consent_id=?").bind(consentId).first();
  if (!connection) return json({ received: true, matched: false });
  const eventType = String(payload.type || "UNKNOWN").slice(0, 80); const status = String(payload.data?.status || payload.status || "").toUpperCase().slice(0, 40);
  const eventId = String(payload.notificationId || `${consentId}:${eventType}:${payload.timestamp || await sha256(rawBody)}`).slice(0, 240);
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO aa_events (event_id,consent_id,event_type,status) VALUES (?,?,?,?)").bind(eventId, consentId, eventType, status).run();
  if (!inserted.meta?.changes) return json({ received: true, duplicate: true });
  try {
    if (eventType === "CONSENT_STATUS_UPDATE") {
      const accounts = (Array.isArray(payload.data?.detail?.accounts) ? payload.data.detail.accounts : []).map((account) => ({ maskedAccNumber: account.maskedAccNumber || "", accType: account.accType || "", fipId: account.fipId || "" }));
      const effectiveStatus = status || (payload.success === false ? "PENDING" : connection.status);
      await env.DB.prepare("UPDATE aa_consents SET status=?,consent_url=CASE WHEN ? IN ('ACTIVE','REJECTED','REVOKED','EXPIRED') THEN '' ELSE consent_url END,accounts_json=CASE WHEN ?<>'[]' THEN ? ELSE accounts_json END,last_error_code=?,last_error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(effectiveStatus, effectiveStatus, JSON.stringify(accounts), JSON.stringify(accounts), String(payload.error?.code || "").slice(0, 100), String(payload.error?.message || "").slice(0, 240), connection.id).run();
    }
    let ingestion = null;
    if (eventType === "FI_DATA_READY" && ["PARTIAL", "COMPLETED"].includes(status)) ingestion = await ingestSetuData(env.DB, connection, payload);
    await audit(env.DB, connection.user_id, "aa.webhook.received", "aa_consent", connection.id, { eventType, status, ingestion });
    return json({ received: true, ingestion });
  } catch (error) {
    await env.DB.prepare("DELETE FROM aa_events WHERE event_id=?").bind(eventId).run();
    await env.DB.prepare("UPDATE aa_consents SET last_error_code='PROCESSING_ERROR',last_error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(String(error.message || "Webhook processing failed").slice(0, 240), connection.id).run();
    return json({ error: "Webhook processing failed" }, 500);
  }
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
  if (request.method === "POST" && url.pathname === "/api/setu/webhook") return handleSetuWebhook(request, env);
  if (request.method === "POST" && url.pathname === "/api/internal/run-reminders") {
    if (!env.INTERNAL_SECRET || request.headers.get("authorization") !== `Bearer ${env.INTERNAL_SECRET}`) return json({ error: "Forbidden" }, 403);
    return json(await processReminders(env));
  }
  const mobileBankConnectionMatch = url.pathname.match(/^\/api\/mobile\/bank-connections\/([^/]+)\/(refresh|revoke)$/);
  const isMobileRoute = ["/api/mobile/sync", "/api/mobile/session", "/api/mobile/push-token", "/api/mobile/transactions", "/api/mobile/account", "/api/mobile/bank-connections", "/api/mobile/bank-connections/setu/consents", "/api/mobile/money-plan"].includes(url.pathname) || mobileBankConnectionMatch;
  if (isMobileRoute) {
    const mobileUser = await getMobileUser(request, env.DB); if (!mobileUser) return json({ error: "Mobile authentication required" }, 401);
    if (request.method === "POST" && url.pathname === "/api/mobile/sync") return syncMobile(env.DB, mobileUser, await request.json());
    if (request.method === "POST" && url.pathname === "/api/mobile/push-token") return savePushDevice(env.DB, mobileUser, await request.json());
    if (request.method === "DELETE" && url.pathname === "/api/mobile/push-token") return deletePushDevice(env.DB, mobileUser, await request.json().catch(() => ({})));
    if (request.method === "DELETE" && url.pathname === "/api/mobile/session") { await env.DB.batch([env.DB.prepare("DELETE FROM push_devices WHERE session_id=?").bind(mobileUser.sessionId), env.DB.prepare("UPDATE mobile_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=?").bind(mobileUser.sessionId)]); return json({ disconnected: true }); }
    if (request.method === "DELETE" && url.pathname === "/api/mobile/transactions") return resetFinancialData(env.DB, mobileUser);
    if (request.method === "DELETE" && url.pathname === "/api/mobile/account") return deleteUserAccount(env, mobileUser);
    if (request.method === "GET" && url.pathname === "/api/mobile/bank-connections") return json({ configured: setuConfig(env).configured, connections: await listBankConnections(env.DB, mobileUser.id) });
    if (request.method === "POST" && url.pathname === "/api/mobile/bank-connections/setu/consents") return createSetuConsent(env, mobileUser, request, { ...(await request.json()), platform: "ios" });
    if (request.method === "POST" && mobileBankConnectionMatch?.[2] === "refresh") return refreshSetuConsent(env, mobileUser, mobileBankConnectionMatch[1]);
    if (request.method === "POST" && mobileBankConnectionMatch?.[2] === "revoke") return revokeSetuConsent(env, mobileUser, mobileBankConnectionMatch[1]);
    if (request.method === "GET" && url.pathname === "/api/mobile/money-plan") return json({ plan: await getMoneyPlan(env.DB, mobileUser, url.searchParams.get("month")) });
    if (request.method === "PUT" && url.pathname === "/api/mobile/money-plan") return saveMoneyPlan(env.DB, mobileUser, await request.json());
    return json({ error: "Not found" }, 404);
  }
  const user = getUser(request);
  if (!user) return json({ error: "Authentication required" }, 401);
  await upsertUser(env.DB, user);
  if (request.method === "GET" && url.pathname === "/api/mobile/authorize") return authorizeMobile(env, user, url);
  if (request.method === "GET" && url.pathname === "/api/mobile/devices") { const rows = await env.DB.prepare("SELECT id,device_name,created_at,last_used_at FROM mobile_sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY last_used_at DESC").bind(user.id).all(); return json({ devices: rows.results }); }
  if (request.method === "GET" && url.pathname === "/api/bootstrap") return json(await bootstrap(env.DB, user, url));
  if (request.method === "GET" && url.pathname === "/api/bank-connections") return json({ configured: setuConfig(env).configured, connections: await listBankConnections(env.DB, user.id) });
  if (request.method === "POST" && url.pathname === "/api/bank-connections/setu/consents") return createSetuConsent(env, user, request, await request.json());
  if (request.method === "GET" && url.pathname === "/api/money-plan") return json({ plan: await getMoneyPlan(env.DB, user, url.searchParams.get("month")) });
  if (request.method === "PUT" && url.pathname === "/api/money-plan") return saveMoneyPlan(env.DB, user, await request.json());
  if (request.method === "GET" && url.pathname === "/api/payment-accounts") return json({ accounts: await listPaymentAccounts(env.DB, user.id) });
  if (request.method === "POST" && url.pathname === "/api/payment-accounts") return savePaymentAccount(env.DB, user, await request.json());
  if (request.method === "GET" && url.pathname === "/api/loans") return json({ loans: await listLoans(env.DB,user.id) });
  if (request.method === "POST" && url.pathname === "/api/loans") return saveLoan(env.DB,user,await request.json());
  if (request.method === "GET" && url.pathname === "/api/transactions") return listTransactions(env.DB, user, url);
  if (request.method === "DELETE" && url.pathname === "/api/transactions") return resetFinancialData(env.DB, user);
  if (request.method === "POST" && url.pathname === "/api/transactions") return createTransaction(env.DB, user, await request.json());
  if (request.method === "POST" && url.pathname === "/api/transactions/import") return importTransactions(env.DB, user, await request.json());
  if (request.method === "DELETE" && url.pathname === "/api/transactions/batch") return deleteTransactions(env.DB, user, await request.json());
  if (request.method === "GET" && url.pathname === "/api/insights") return getInsights(env.DB, user, url);
  if (request.method === "POST" && url.pathname === "/api/reviews/batch") return batchExplain(env.DB, user, await request.json());
  if (request.method === "PUT" && url.pathname === "/api/preferences") return savePreferences(env.DB, user, await request.json());
  if (request.method === "GET" && url.pathname === "/api/export") {
    const data = await env.DB.prepare("SELECT amount_paise,merchant,description,occurred_at,time_verified,category,review_status,context,source,account_tag,loan_id,emi_number,principal_component_paise,interest_component_paise FROM transactions WHERE user_id=? ORDER BY occurred_at DESC").bind(user.id).all();
    const plans = await env.DB.prepare("SELECT month,income_paise,planned_savings_paise,fixed_costs_paise,intention,reflection,updated_at FROM monthly_money_plans WHERE user_id=? ORDER BY month DESC").bind(user.id).all();
    return json({ exportedAt: new Date().toISOString(), user: { email: user.email }, transactions: data.results, loans:await listLoans(env.DB,user.id), paymentAccounts:await listPaymentAccounts(env.DB,user.id), moneyPlans: plans.results, bankConnections: await listBankConnections(env.DB, user.id) });
  }
  if (request.method === "DELETE" && url.pathname === "/api/account") {
    return deleteUserAccount(env, user);
  }
  const transactionMatch = url.pathname.match(/^\/api\/transactions\/([^/]+)$/);
  const accountMatch = url.pathname.match(/^\/api\/payment-accounts\/([^/]+)$/);
  if (request.method === "PUT" && accountMatch) return savePaymentAccount(env.DB,user,{...(await request.json()),id:accountMatch[1]});
  if (request.method === "DELETE" && accountMatch) return deletePaymentAccount(env.DB, user, accountMatch[1]);
  const loanMatch=url.pathname.match(/^\/api\/loans\/([^/]+)$/); if(request.method==="PUT"&&loanMatch)return saveLoan(env.DB,user,{...(await request.json()),id:loanMatch[1]}); if(request.method==="DELETE"&&loanMatch)return deleteLoan(env.DB,user,loanMatch[1]);
  const bankConnectionMatch = url.pathname.match(/^\/api\/bank-connections\/([^/]+)\/(refresh|revoke)$/);
  if (request.method === "POST" && bankConnectionMatch?.[2] === "refresh") return refreshSetuConsent(env, user, bankConnectionMatch[1]);
  if (request.method === "POST" && bankConnectionMatch?.[2] === "revoke") return revokeSetuConsent(env, user, bankConnectionMatch[1]);
  const categoryMatch = url.pathname.match(/^\/api\/transactions\/([^/]+)\/category$/);
  if (request.method === "PATCH" && categoryMatch) return setTransactionCategory(env.DB, user, categoryMatch[1], await request.json());
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
