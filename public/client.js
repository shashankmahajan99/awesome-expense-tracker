const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const dialogs = { review: $("#review-dialog"), batch: $("#batch-dialog"), preferences: $("#preferences-dialog"), completion: $("#completion-dialog"), import: $("#import-dialog") };
const formatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const tones = ["amber", "red", "blue", "green", "yellow"];
let items = [];
let current = 0;
let reviewedCount = 0;
let preferences = null;
let pendingImport = [];
let pendingImportSource = "csv";
let activeRecognition = null;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function showToast(title, detail) {
  const toast = $(".toast");
  toast.querySelector("strong").textContent = title;
  toast.querySelector("small").textContent = detail;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 2600);
}

function mapTransaction(transaction, index) {
  const merchant = transaction.merchant || "Unknown payment";
  return {
    id: String(transaction.id), merchant,
    meta: new Date(transaction.occurredAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }),
    amount: formatter.format(Number(transaction.amountPaise || 0) / 100),
    icon: merchant.slice(0, 2).toUpperCase(), tone: tones[index % tones.length],
    status: "Needs context", detail: transaction.category ? `Likely ${transaction.category}` : "Category uncertain",
    occurredAt: transaction.occurredAt, amountPaise: Number(transaction.amountPaise || 0), category: transaction.category,
    description: transaction.description, context: transaction.context, reviewStatus: transaction.reviewStatus,
  };
}

function transactionButton(item) {
  const button = document.createElement("button");
  button.className = "transaction"; button.type = "button"; button.dataset.id = item.id;
  const icon = document.createElement("span"); icon.className = `merchant-icon ${item.tone}`; icon.textContent = item.icon;
  const info = document.createElement("span"); info.className = "merchant-info";
  const name = document.createElement("strong"); name.textContent = item.merchant;
  const meta = document.createElement("small"); meta.textContent = item.meta; info.append(name, meta);
  const context = document.createElement("span"); context.className = "transaction-context";
  const status = document.createElement("span"); status.textContent = item.status;
  const detail = document.createElement("small"); detail.textContent = item.detail; context.append(status, detail);
  const amount = document.createElement("strong"); amount.className = "amount"; amount.textContent = item.amount;
  const chevron = document.createElement("span"); chevron.className = "chevron"; chevron.textContent = "›";
  button.append(icon, info, context, amount, chevron);
  button.addEventListener("click", () => openReview(item.id));
  return button;
}

function syncQueue() {
  $("#transaction-list").replaceChildren(...items.map(transactionButton));
  $("#transaction-list").setAttribute("aria-busy", "false");
  $$('[data-inbox-count]').forEach((node) => node.textContent = String(items.length));
  $("#batch-list").replaceChildren(...items.map((item) => {
    const chip = document.createElement("span"); chip.dataset.batchId = item.id;
    const dot = document.createElement("i"); dot.className = `mini-dot ${item.tone}`;
    chip.append(dot, `${item.merchant} · ${item.amount}`); return chip;
  }));
  $(".empty-inbox").hidden = Boolean(items.length);
}

function renderReview() {
  if (!items.length) {
    dialogs.review?.close(); dialogs.batch?.close(); syncQueue();
    $("#completed-count").textContent = String(reviewedCount);
    dialogs.completion?.showModal(); return;
  }
  current = Math.min(current, items.length - 1);
  const item = items[current];
  $("#review-position").textContent = String(current + 1); $("#review-total").textContent = String(items.length);
  $("#review-progress").style.width = `${((current + 1) / items.length) * 100}%`;
  $("#review-icon").textContent = item.icon; $("#review-icon").className = `merchant-icon ${item.tone} large`;
  $("#review-meta").textContent = item.meta.toUpperCase(); $("#review-amount").textContent = item.amount; $("#review-merchant").textContent = item.merchant;
  $("#review-question").textContent = item.merchant === "Indian Oil" ? "Was this fuel for your Kushaq?" : "What was this payment for?";
  $("#review-hint").textContent = item.detail; $("#answer-input").value = "";
}

function openReview(id) {
  if (id) current = Math.max(0, items.findIndex((item) => item.id === String(id)));
  renderReview(); dialogs.review?.showModal();
}

async function resolveCurrent(action, message, context = "") {
  const item = items[current];
  if (!item) return;
  try {
    await api(`/api/transactions/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ action, context }) });
    items.splice(current, 1); reviewedCount++; syncQueue();
    showToast(message, items.length ? `${items.length} payment${items.length === 1 ? "" : "s"} still need context` : "Today’s review is complete");
    dialogs.review?.close();
    if (!items.length) renderReview();
  } catch (error) { showToast("Couldn’t save yet", error.message); }
}

function stopVoice() {
  if (activeRecognition) { activeRecognition.stop(); activeRecognition = null; }
}

function voiceState(target, button, listening) {
  button?.classList.toggle("listening", listening); target?.closest("label")?.classList.toggle("listening", listening);
  const loader = target?.closest("label")?.querySelector(".field-loader"); if (loader) loader.hidden = !listening;
  const label = button?.querySelector("[data-voice-label]") || (button?.matches("[data-voice-label]") ? button : null);
  if (label) label.textContent = listening ? (button.id === "batch-voice" ? "■ Stop speaking" : "Stop speaking") : (button.id === "batch-voice" ? "● Speak instead" : "Tap to speak");
  const hint = button?.querySelector("[data-voice-hint]"); if (hint) hint.textContent = listening ? "Listening… tap again to stop" : "or type your answer below";
}

function startVoice(target, listeningButton) {
  if (activeRecognition) { stopVoice(); return; }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { target.focus(); showToast("Voice isn’t available here", "You can type instead"); return; }
  const recognition = new SpeechRecognition(); recognition.lang = "en-IN";
  activeRecognition = recognition;
  recognition.interimResults = true; recognition.continuous = true;
  recognition.onstart = () => voiceState(target, listeningButton, true);
  recognition.onresult = (event) => { target.value = [...event.results].map((result) => result[0].transcript).join(" "); target.dispatchEvent(new Event("input")); };
  recognition.onerror = (event) => { if (event.error !== "aborted") showToast("Voice stopped", "You can continue by typing"); };
  recognition.onend = () => { voiceState(target, listeningButton, false); if (activeRecognition === recognition) activeRecognition = null; };
  recognition.start();
}

function applyPreferences(value) {
  preferences = value;
  const [hour, minute] = value.reviewTime.split(":").map(Number);
  $("#next-review-time").textContent = new Date(2026, 0, 1, hour, minute).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  $("#reminder-mode").textContent = value.personality;
  $("#reminder-suffix").textContent = " reminder · today";
}

function renderDashboardInsights(insights) {
  const colors = ["#e6825b", "#5f8f87", "#dbad4d", "#7685a8"];
  const largest = insights.largest;
  $("#largest-payment").textContent = largest ? formatter.format(largest.amountPaise / 100) : "—";
  $("#largest-detail").textContent = largest ? largest.merchant : "No payments yet";
  $("#visual-largest").textContent = largest ? formatter.format(largest.amountPaise / 100) : "—";
  $("#snapshot-total").textContent = formatter.format(insights.totals.amountPaise / 100);
  $("#snapshot-caption").textContent = `${insights.totals.count} payments tracked`;

  const days = insights.days.slice(-7); const maxDay = Math.max(1, ...days.map((item) => item.amountPaise));
  const barRoot = $("#snapshot-bars"); barRoot.replaceChildren(); barRoot.classList.remove("skeleton-bars"); barRoot.setAttribute("aria-busy", "false");
  for (const item of days) {
    const column = document.createElement("div"); const bar = document.createElement("i"); bar.style.height = `${Math.max(6, item.amountPaise / maxDay * 100)}%`;
    const label = document.createElement("small"); label.textContent = new Date(`${item.day}T12:00:00`).toLocaleDateString("en-IN", { weekday: "narrow" }); column.append(bar, label); barRoot.append(column);
  }
  if (!days.length) { const empty = document.createElement("p"); empty.className = "chart-empty"; empty.textContent = "Import transactions to build your spending pattern."; barRoot.append(empty); }

  const categoryRoot = $("#dashboard-categories"); categoryRoot.replaceChildren(); categoryRoot.setAttribute("aria-busy", "false");
  const categories = insights.categories.slice(0, 4); const maxCategory = Math.max(1, ...categories.map((item) => item.amountPaise));
  categories.forEach((item, index) => {
    const row = document.createElement("div"); row.className = "category"; const top = document.createElement("div");
    const dot = document.createElement("span"); dot.className = "dot"; dot.style.background = colors[index % colors.length];
    const name = document.createElement("strong"); name.textContent = item.name; const amount = document.createElement("b"); amount.textContent = formatter.format(item.amountPaise / 100); top.append(dot, name, amount);
    const track = document.createElement("div"); track.className = "track"; const fill = document.createElement("i"); fill.style.width = `${item.amountPaise / maxCategory * 100}%`; fill.style.background = colors[index % colors.length]; track.append(fill); row.append(top, track); categoryRoot.append(row);
  });
  if (!categories.length) { const empty = document.createElement("p"); empty.className = "category-empty"; empty.textContent = "Categories will appear after your first import."; categoryRoot.append(empty); }
  const topCategory = categories[0];
  $("#snapshot-note").replaceChildren(); const sparkle = document.createElement("span"); sparkle.textContent = "✦"; const note = document.createElement("p");
  const noteTitle = document.createElement("strong"); noteTitle.textContent = topCategory ? `${topCategory.name} is your largest category.` : "Your insights are ready when you are.";
  const noteDetail = document.createElement("small"); noteDetail.textContent = topCategory ? `${formatter.format(topCategory.amountPaise / 100)} across ${topCategory.count} payment${topCategory.count === 1 ? "" : "s"}.` : "Import a bank statement or add a payment."; note.append(noteTitle, document.createElement("br"), noteDetail); $("#snapshot-note").append(sparkle, note);
  $("#focus-title").textContent = topCategory ? `${topCategory.name} accounts for ${formatter.format(topCategory.amountPaise / 100)}.` : "Add transactions to see what changed.";
  $("#focus-detail").textContent = topCategory ? `${topCategory.count} payment${topCategory.count === 1 ? "" : "s"} make it your largest tracked category.` : "Paisa will turn your imported statement into a clear daily inbox.";
}

function populatePreferences(value) {
  if (!value) return;
  const form = $("#preferences-form");
  form.elements.personality.value = value.personality; form.elements.reviewTime.value = value.reviewTime;
  form.elements.importantAmount.value = value.importantAmount; form.elements.quietStart.value = value.quietStart;
  form.elements.quietEnd.value = value.quietEnd; form.elements.weeklyCleanup.checked = value.weeklyCleanup;
}

function parseCSV(text) {
  const rows = []; let row = []; let field = ""; let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') { field += '"'; index++; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { row.push(field.trim()); field = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) { if (character === "\r" && text[index + 1] === "\n") index++; row.push(field.trim()); if (row.some(Boolean)) rows.push(row); row = []; field = ""; }
    else field += character;
  }
  row.push(field.trim()); if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows.shift().map((header) => header.toLowerCase().replace(/\s+/g, ""));
  const find = (...names) => headers.findIndex((header) => names.includes(header));
  const dateIndex = find("date", "transactiondate", "datetime"); const merchantIndex = find("merchant", "description", "narration", "payee");
  const amountIndex = find("amount", "debit", "withdrawal"); const categoryIndex = find("category", "type");
  if (merchantIndex < 0 || amountIndex < 0) return [];
  return rows.map((values) => ({ date: values[dateIndex] || new Date().toISOString(), merchant: values[merchantIndex], amount: Number(String(values[amountIndex]).replace(/[^0-9.-]/g, "")), category: categoryIndex >= 0 ? values[categoryIndex] : "Uncategorised" })).filter((item) => item.merchant && item.amount > 0);
}

function statementDate(value) {
  const match = value.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/); if (!match) return null;
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]); const date = new Date(year, Number(match[2]) - 1, Number(match[1]), 12);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseStatementText(lines) {
  const ignored = /opening balance|closing balance|available balance|total debit|total credit|statement summary|page \d|date narration|account number|customer id/i;
  const candidates = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim(); const date = statementDate(line); if (!date || ignored.test(line)) continue;
    const amountMatches = [...line.matchAll(/(?:₹|INR|Rs\.?)?\s*([0-9][0-9,]*\.\d{2})(?=\s|$|Cr|Dr)/gi)]; if (!amountMatches.length) continue;
    const match = amountMatches[amountMatches.length - 1]; const amount = Number(match[1].replaceAll(",", "")); if (!amount || amount > 100000000) continue;
    let merchant = line.replace(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/, "").replace(match[0], "").replace(/\b(?:DR|CR|debit|credit)\b/gi, "").replace(/\s+/g, " ").trim();
    merchant = merchant.replace(/^[|:\-\s]+|[|:\-\s]+$/g, "").slice(0, 160); if (!merchant || /^\d+$/.test(merchant)) continue;
    candidates.push({ date, merchant, description: line.slice(0, 300), amount, category: "Uncategorised" });
  }
  return candidates;
}

async function parsePDF(file, password = "") {
  const pdfjs = await import("/vendor/pdf.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.mjs";
  const bytes = new Uint8Array(await file.arrayBuffer());
  let task = pdfjs.getDocument({ data: bytes, password });
  let document;
  try { document = await task.promise; }
  catch (error) {
    if (error?.name !== "PasswordException") throw error;
    const entered = window.prompt("This bank statement is password-protected. Enter its password. It stays in this browser only.");
    if (!entered) throw new Error("A password is required to read this statement");
    task = pdfjs.getDocument({ data: bytes, password: entered }); document = await task.promise;
  }
  const lines = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber); const content = await page.getTextContent();
    const byLine = new Map();
    for (const item of content.items) { const y = Math.round(item.transform?.[5] || 0); if (!byLine.has(y)) byLine.set(y, []); byLine.get(y).push(item); }
    [...byLine.entries()].sort((a, b) => b[0] - a[0]).forEach(([, itemsOnLine]) => lines.push(itemsOnLine.sort((a, b) => (a.transform?.[4] || 0) - (b.transform?.[4] || 0)).map((item) => item.str).join(" ")));
  }
  return parseStatementText(lines);
}

async function loadDashboard() {
  try {
    const [data, insights] = await Promise.all([api("/api/bootstrap"), api("/api/insights")]);
    items = data.transactions.map(mapTransaction); reviewedCount = 0; syncQueue(); applyPreferences(data.preferences);
    const firstName = (data.user.name || "there").split(" ")[0]; $(".topbar h1").textContent = `Good evening, ${firstName}.`;
    $("[data-profile-name]").textContent = data.user.name || firstName; $("[data-profile-email]").textContent = data.user.email || "Private account";
    const understood = data.totals.count ? Math.round(((data.totals.count - data.summary.count) / data.totals.count) * 100) : 100;
    $("#hero-title").textContent = data.summary.count ? "A few things need your attention." : "Everything makes sense.";
    $("#hero-summary").textContent = data.summary.count ? `${data.summary.count} payment${data.summary.count === 1 ? "" : "s"} worth ${formatter.format(data.summary.amountPaise / 100)} need a little context. Everything else is out of your way.` : "Your inbox is clear. Add or import transactions whenever you’re ready.";
    $$('[data-review-label]').forEach((node) => node.textContent = data.summary.count ? `Review ${data.summary.count} payment${data.summary.count === 1 ? "" : "s"}` : "Inbox clear");
    $$('[data-open-review]').forEach((button) => { button.disabled = !data.summary.count; button.classList.remove("loading-control"); });
    $$('[data-open-batch]').forEach((button) => button.disabled = !data.summary.count);
    $("#review-estimate").textContent = data.summary.count ? `~${Math.max(1, Math.ceil(data.summary.count * .3))} min` : "Done";
    $("#tracked-total").textContent = formatter.format(data.totals.amountPaise / 100); $("#tracked-count").textContent = `${data.totals.count} payments tracked`;
    $("#understood-percent").textContent = `${understood}%`; $("#understood-detail").textContent = data.summary.count ? `${data.summary.count} still need context` : "Everything is understood";
    $("#visual-total").textContent = formatter.format(data.totals.amountPaise / 100); $("#visual-understood").textContent = `${understood}%`; $("#visual-unresolved").textContent = formatter.format(data.summary.amountPaise / 100);
    renderDashboardInsights(insights);
  } catch (error) {
    $("#hero-summary").textContent = "We couldn’t load your dashboard just now. Your data is safe; refresh to try again.";
    $("#transaction-list").setAttribute("aria-busy", "false");
    showToast("Dashboard unavailable", "Please refresh in a moment");
  }
}

$$('[data-open-review]').forEach((button) => button.addEventListener("click", () => openReview()));
$$('[data-close-review]').forEach((button) => button.addEventListener("click", () => { stopVoice(); dialogs.review.close(); }));
$("#submit-answer")?.addEventListener("click", () => $("#answer-input").value.trim() && resolveCurrent("explain", "Context saved", $("#answer-input").value.trim()));
$("#answer-input")?.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.currentTarget.value.trim()) resolveCurrent("explain", "Context saved", event.currentTarget.value.trim()); });
$$('[data-action]').forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.action === "skip") resolveCurrent("defer", "Saved for later");
  else if (button.dataset.action === "known") resolveCurrent("known", "Marked as known");
  else { const merchant = items[current]?.merchant || ""; dialogs.review.close(); $("#batch-input").value = `${merchant} was part of `; dialogs.batch.showModal(); $("#batch-input").focus(); }
}));
$("#voice-button")?.addEventListener("click", () => startVoice($("#answer-input"), $("#voice-button")));

$$('[data-open-batch]').forEach((button) => button.addEventListener("click", () => { $("#batch-result").hidden = true; $("#batch-input").value = ""; dialogs.batch.showModal(); }));
$$('[data-close-batch]').forEach((button) => button.addEventListener("click", () => { stopVoice(); dialogs.batch.close(); }));
$("#batch-voice")?.addEventListener("click", () => startVoice($("#batch-input"), $("#batch-voice")));
$("#batch-submit")?.addEventListener("click", async () => {
  const text = $("#batch-input").value.trim(); if (!text) return $("#batch-input").focus();
  try {
    const result = await api("/api/reviews/batch", { method: "POST", body: JSON.stringify({ text }) });
    const matched = new Set(result.matched.map(String)); const matchedItems = items.filter((item) => matched.has(item.id));
    items = items.filter((item) => !matched.has(item.id)); reviewedCount += matchedItems.length; syncQueue(); $("#batch-result").hidden = false;
    $("#batch-result-text").textContent = matchedItems.length ? `Matched ${matchedItems.map((item) => item.merchant).join(", ")}. ${items.length} remain.` : "No merchant names matched. Try mentioning a merchant directly.";
    if (!items.length) setTimeout(renderReview, 850);
  } catch (error) { showToast("Couldn’t apply explanation", error.message); }
});

$$('[data-open-preferences]').forEach((button) => button.addEventListener("click", () => { populatePreferences(preferences); dialogs.preferences.showModal(); $(".sidebar")?.classList.remove("open"); }));
$$('[data-close-preferences]').forEach((button) => button.addEventListener("click", () => dialogs.preferences.close()));
$("#preferences-form")?.addEventListener("submit", async (event) => {
  event.preventDefault(); const data = new FormData(event.currentTarget);
  const value = { personality: data.get("personality"), reviewTime: data.get("reviewTime"), importantAmount: data.get("importantAmount"), quietStart: data.get("quietStart"), quietEnd: data.get("quietEnd"), weeklyCleanup: data.get("weeklyCleanup") === "on", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  try { const saved = await api("/api/preferences", { method: "PUT", body: JSON.stringify(value) }); applyPreferences(saved); dialogs.preferences.close(); showToast("Preferences saved", "Synced across your devices"); }
  catch (error) { showToast("Couldn’t save preferences", error.message); }
});
$("#export-data")?.addEventListener("click", async () => {
  try { const data = await api("/api/export"); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = `paisa-export-${new Date().toISOString().slice(0,10)}.json`; link.click(); URL.revokeObjectURL(url); showToast("Export ready", "Your private data copy was downloaded"); }
  catch (error) { showToast("Export failed", error.message); }
});
$("#delete-account")?.addEventListener("click", async () => {
  if (!window.confirm("Permanently delete all Paisa transactions, reviews, preferences, and audit data for this account? This cannot be undone.")) return;
  try { await api("/api/account", { method: "DELETE" }); dialogs.preferences.close(); items = []; syncQueue(); showToast("Account data deleted", "Your Paisa records have been permanently removed"); }
  catch (error) { showToast("Deletion failed", error.message); }
});

$$('[data-open-import]').forEach((button) => button.addEventListener("click", () => dialogs.import.showModal()));
$$('[data-close-import]').forEach((button) => button.addEventListener("click", () => dialogs.import.close()));
$("#statement-file")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  if (file.size > 20_000_000) return showToast("File is too large", "Use a PDF or CSV under 20 MB");
  $("#import-loading").hidden = false; $("#import-preview").hidden = true; $("#import-submit").disabled = true;
  try {
    const isPDF = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"); pendingImportSource = isPDF ? "bank_pdf" : "csv";
    pendingImport = isPDF ? await parsePDF(file) : parseCSV(await file.text());
    $("#import-preview").hidden = false; $("#import-count").textContent = pendingImport.length ? `${pendingImport.length} transactions ready` : "No transaction rows detected";
    $("#import-filename").textContent = pendingImport.length ? `${file.name} · review them after import` : `${file.name} · try a selectable-text PDF or CSV`;
    $("#import-submit").disabled = !pendingImport.length;
  } catch (error) { pendingImport = []; showToast("Couldn’t read statement", error.message || "Try downloading the statement again"); }
  finally { $("#import-loading").hidden = true; }
});
$("#clear-import")?.addEventListener("click", () => { pendingImport = []; $("#statement-file").value = ""; $("#import-preview").hidden = true; $("#import-submit").disabled = true; });
$("#import-submit")?.addEventListener("click", async () => {
  try { const result = await api("/api/transactions/import", { method: "POST", body: JSON.stringify({ transactions: pendingImport, source: pendingImportSource }) }); dialogs.import.close(); showToast(`${result.imported} transactions imported`, `${result.duplicates} duplicates safely skipped · manage them in Transactions`); await loadDashboard(); }
  catch (error) { showToast("Import failed", error.message); }
});

$$('[data-close-completion]').forEach((button) => button.addEventListener("click", () => dialogs.completion.close()));
$(".menu-button")?.addEventListener("click", () => $(".sidebar")?.classList.toggle("open"));
Object.values(dialogs).filter(Boolean).forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target === dialog) { stopVoice(); dialog.close(); } }));
const params = new URLSearchParams(location.search);
if (params.has("preferences")) setTimeout(() => { populatePreferences(preferences); dialogs.preferences?.showModal(); }, 400);
if (params.has("import")) dialogs.import?.showModal();
if (params.has("review")) setTimeout(() => openReview(params.get("review")), 400);
document.addEventListener("keydown", (event) => { if (dialogs.review?.open && event.key.toLowerCase() === "s" && document.activeElement !== $("#answer-input")) { event.preventDefault(); resolveCurrent("defer", "Saved for later"); } });
loadDashboard();
