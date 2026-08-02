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
  $("#inbox-count").textContent = String(items.length);
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
    showToast(message, items.length ? "Saved securely · moving to the next payment" : "Today’s review is complete");
    renderReview();
  } catch (error) { showToast("Couldn’t save yet", error.message); }
}

function startVoice(target, listeningButton) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { target.focus(); showToast("Voice isn’t available here", "You can type instead"); return; }
  const recognition = new SpeechRecognition(); recognition.lang = "en-IN";
  recognition.onstart = () => listeningButton?.classList.add("listening");
  recognition.onresult = (event) => { target.value = event.results[0][0].transcript; target.dispatchEvent(new Event("input")); };
  recognition.onend = () => listeningButton?.classList.remove("listening"); recognition.start();
}

function applyPreferences(value) {
  preferences = value;
  const [hour, minute] = value.reviewTime.split(":").map(Number);
  $("#next-review-time").textContent = new Date(2026, 0, 1, hour, minute).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  $("#reminder-mode").textContent = value.personality;
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

async function loadDashboard() {
  try {
    const data = await api("/api/bootstrap");
    items = data.transactions.map(mapTransaction); reviewedCount = 0; syncQueue(); applyPreferences(data.preferences);
    const firstName = (data.user.name || "there").split(" ")[0]; $(".topbar h1").textContent = `Good evening, ${firstName}.`;
    $(".profile strong").textContent = data.user.name || firstName; $(".profile small").textContent = data.user.email || "Private account";
  } catch (error) { showToast("Preview mode", "Persistent services are starting; sample data remains available"); }
}

$$('[data-open-review]').forEach((button) => button.addEventListener("click", () => openReview()));
$$('[data-close-review]').forEach((button) => button.addEventListener("click", () => dialogs.review.close()));
$("#submit-answer")?.addEventListener("click", () => $("#answer-input").value.trim() && resolveCurrent("explain", "Context saved", $("#answer-input").value.trim()));
$("#answer-input")?.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.currentTarget.value.trim()) resolveCurrent("explain", "Context saved", event.currentTarget.value.trim()); });
$$('[data-action]').forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.action === "skip") resolveCurrent("defer", "Saved for later");
  else if (button.dataset.action === "known") resolveCurrent("known", "Marked as known");
  else { const merchant = items[current]?.merchant || ""; dialogs.review.close(); $("#batch-input").value = `${merchant} was part of `; dialogs.batch.showModal(); $("#batch-input").focus(); }
}));
$("#voice-button")?.addEventListener("click", () => startVoice($("#answer-input"), $("#voice-button")));

$$('[data-open-batch]').forEach((button) => button.addEventListener("click", () => { $("#batch-result").hidden = true; $("#batch-input").value = ""; dialogs.batch.showModal(); }));
$$('[data-close-batch]').forEach((button) => button.addEventListener("click", () => dialogs.batch.close()));
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
$("#csv-file")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  if (file.size > 5_000_000) return showToast("File is too large", "Use a CSV under 5 MB");
  pendingImport = parseCSV(await file.text()); $("#import-preview").hidden = false; $("#import-count").textContent = `${pendingImport.length} transactions ready`; $("#import-filename").textContent = file.name; $("#import-submit").disabled = !pendingImport.length;
});
$("#clear-import")?.addEventListener("click", () => { pendingImport = []; $("#csv-file").value = ""; $("#import-preview").hidden = true; $("#import-submit").disabled = true; });
$("#import-submit")?.addEventListener("click", async () => {
  try { const result = await api("/api/transactions/import", { method: "POST", body: JSON.stringify({ transactions: pendingImport, source: "csv" }) }); dialogs.import.close(); showToast(`${result.imported} transactions imported`, `${result.duplicates} duplicates safely skipped`); await loadDashboard(); }
  catch (error) { showToast("Import failed", error.message); }
});

$$('[data-close-completion]').forEach((button) => button.addEventListener("click", () => dialogs.completion.close()));
$(".menu-button")?.addEventListener("click", () => $(".sidebar")?.classList.toggle("open"));
document.addEventListener("keydown", (event) => { if (dialogs.review?.open && event.key.toLowerCase() === "s" && document.activeElement !== $("#answer-input")) { event.preventDefault(); resolveCurrent("defer", "Saved for later"); } });
loadDashboard();
