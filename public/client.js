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
let pendingImportFiles = [];
let activeRecognition = null;
let reviewSaving = false;
let batchMatching = false;

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

function setButtonLoading(button, loading) {
  if (!button) return;
  button.disabled = loading; button.classList.toggle("button-loading", loading); button.setAttribute("aria-busy", String(loading));
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
    description: transaction.description, context: transaction.context, reviewStatus: transaction.reviewStatus, accountTag: transaction.accountTag || "",
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
  if (!item || reviewSaving) return;
  reviewSaving = true; const button = action === "explain" ? $("#submit-answer") : $(`[data-action="${action === "defer" ? "skip" : action}"]`); setButtonLoading(button, true);
  try {
    await api(`/api/transactions/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ action, context }) });
    items.splice(current, 1); reviewedCount++; syncQueue();
    showToast(message, items.length ? `${items.length} payment${items.length === 1 ? "" : "s"} still need context` : "Today’s review is complete");
    renderReview();
  } catch (error) { showToast("Couldn’t save yet", error.message); }
  finally { reviewSaving = false; setButtonLoading(button, false); }
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

function accountTagFor(filename, text = "") {
  const value = `${filename} ${text}`.toLowerCase();
  const bank = [["icici", "ICICI"], ["hdfc", "HDFC"], ["axis", "Axis"], ["sbi", "SBI"], ["kotak", "Kotak"], ["yes bank", "YES Bank"]].find(([key]) => value.includes(key))?.[1];
  if (value.includes("paytm")) return bank ? `Paytm - Savings ${bank}` : "Paytm Wallet";
  if (value.includes("rupay")) return bank ? `RuPay Card - ${bank}` : "RuPay Card";
  if (value.includes("credit card") || value.includes("card statement")) return bank ? `Credit Card - ${bank}` : "Credit Card";
  return bank ? `Savings - ${bank}` : "Bank account";
}

function importSource(filename, accountTag) {
  const value = `${filename} ${accountTag}`.toLowerCase(); const pdf = filename.toLowerCase().endsWith(".pdf");
  return value.includes("paytm") ? (pdf ? "paytm_pdf" : "paytm_csv") : (pdf ? "bank_pdf" : "bank_csv");
}

function parseCSV(text, file) {
  const rows = []; let row = []; let field = ""; let quoted = false;
  const sample = text.split(/\r?\n/).slice(0, 5).join("\n");
  const delimiter = [",", "\t", ";", "|"].sort((a, b) => sample.split(b).length - sample.split(a).length)[0];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') { field += '"'; index++; }
    else if (character === '"') quoted = !quoted;
    else if (character === delimiter && !quoted) { row.push(field.trim()); field = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) { if (character === "\r" && text[index + 1] === "\n") index++; row.push(field.trim()); if (row.some(Boolean)) rows.push(row); row = []; field = ""; }
    else field += character;
  }
  row.push(field.trim()); if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) return { rows: [], accountTag: accountTagFor(file.name, text.slice(0, 2000)), detail: "No tabular rows found" };
  const headers = rows.shift().map((header) => header.toLowerCase().replace(/[^a-z]/g, ""));
  const find = (...names) => headers.findIndex((header) => names.some((name) => header === name || header.includes(name)));
  const dateIndex = find("date", "transactiondate", "valuedate", "datetime"); const merchantIndex = find("merchant", "description", "narration", "payee", "details");
  const debitIndex = find("debit", "withdrawal", "debitamount", "withdrawalamount"); const creditIndex = find("credit", "deposit", "creditamount");
  const amountIndex = find("amount", "transactionamount"); const typeIndex = find("type", "drcr", "transactiontype"); const categoryIndex = find("category");
  const referenceIndex = find("reference", "transactionid", "utr", "refno", "orderid");
  const accountTag = accountTagFor(file.name, `${headers.join(" ")} ${text.slice(0, 2000)}`); const source = importSource(file.name, accountTag);
  if (merchantIndex < 0 || (debitIndex < 0 && amountIndex < 0)) return { rows: [], accountTag, detail: "Date, narration, or debit columns were not recognized" };
  const parsed = rows.map((values) => {
    const value = (index) => index >= 0 ? String(values[index] || "").trim() : "";
    const debit = Number(value(debitIndex).replace(/[^0-9.-]/g, "")); const amount = debit > 0 ? debit : Number(value(amountIndex).replace(/[^0-9.-]/g, ""));
    const type = value(typeIndex).toLowerCase(); const hasCreditOnly = !(debit > 0) && creditIndex >= 0 && Number(value(creditIndex).replace(/[^0-9.-]/g, "")) > 0;
    return { occurredAt: statementDate(value(dateIndex)) || new Date().toISOString(), merchant: value(merchantIndex), description: value(merchantIndex), amount, category: categoryIndex >= 0 ? value(categoryIndex) || "Uncategorised" : "Uncategorised", accountTag, sourceFile: file.name, source, reference: value(referenceIndex), credit: hasCreditOnly || /\b(cr|credit)\b/.test(type) };
  }).filter((item) => item.merchant && item.amount > 0 && !item.credit);
  return { rows: parsed, accountTag, detail: `${parsed.length} debit rows · ${headers.length} columns detected` };
}

function statementDate(value) {
  const iso = value.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/); if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12).toISOString();
  const named = value.match(/\b(\d{1,2})[- ](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[- ](\d{2,4})\b/i);
  if (named) { const date = new Date(`${named[1]} ${named[2]} ${named[3].length === 2 ? `20${named[3]}` : named[3]} 12:00:00`); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
  const match = value.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/); if (!match) return null;
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]); const date = new Date(year, Number(match[2]) - 1, Number(match[1]), 12);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseStatementText(lines, file) {
  const ignored = /opening balance|closing balance|available balance|total debit|total credit|statement summary|page \d|date narration|account number|customer id/i;
  const candidates = []; const accountTag = accountTagFor(file.name, lines.slice(0, 80).join(" ")); const source = importSource(file.name, accountTag);
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim(); const date = statementDate(line); if (!date || ignored.test(line)) continue;
    if (/\b(?:CR|credit|deposit)\b/i.test(line) && !/\b(?:DR|debit|withdrawal|paid|sent)\b/i.test(line)) continue;
    const amountMatches = [...line.matchAll(/(?:₹|INR|Rs\.?)?\s*([0-9][0-9,]*\.\d{2})(?=\s|$|Cr|Dr)/gi)]; if (!amountMatches.length) continue;
    const match = amountMatches[0]; const amount = Number(match[1].replaceAll(",", "")); if (!amount || amount > 100000000) continue;
    let merchant = line.replace(/\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{1,2}[- ](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[- ]\d{2,4})\b/i, "");
    for (const amountMatch of [...amountMatches].reverse()) merchant = merchant.replace(amountMatch[0], " ");
    merchant = merchant.replace(/\b(?:DR|CR|debit|credit|withdrawal)\b/gi, "").replace(/\b(?:UPI|IMPS|NEFT|POS|ECOM|VPS|IPS|ATM|REF|TXN)\b[:/ -]*/gi, " ").replace(/\s+/g, " ").trim();
    merchant = merchant.replace(/^[|:\-\s]+|[|:\-\s]+$/g, "").slice(0, 160); if (!merchant || /^\d+$/.test(merchant)) continue;
    const reference = line.match(/(?:UTR|UPI ref|reference|ref no|transaction id|order id)[:\s-]*([A-Z0-9-]{6,40})/i)?.[1] || "";
    candidates.push({ occurredAt: date, merchant, description: `${line.slice(0, 240)}${reference ? ` · Reference: ${reference}` : ""}`, amount, category: "Uncategorised", accountTag, sourceFile: file.name, source, reference });
  }
  return { rows: candidates, accountTag, detail: `${candidates.length} debit rows · ${lines.length} text rows examined` };
}

async function parsePDF(file, onProgress, password = "") {
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
    onProgress?.(pageNumber - 1, document.numPages, `${lines.length} text rows detected`);
    const page = await document.getPage(pageNumber); const content = await page.getTextContent();
    const byLine = new Map();
    for (const item of content.items) { const y = Math.round(item.transform?.[5] || 0); if (!byLine.has(y)) byLine.set(y, []); byLine.get(y).push(item); }
    [...byLine.entries()].sort((a, b) => b[0] - a[0]).forEach(([, itemsOnLine]) => lines.push(itemsOnLine.sort((a, b) => (a.transform?.[4] || 0) - (b.transform?.[4] || 0)).map((item) => item.str).join(" ")));
    onProgress?.(pageNumber, document.numPages, `${lines.length} text rows detected`);
  }
  return parseStatementText(lines, file);
}

function renderImportFiles() {
  const root = $("#import-files"); root.replaceChildren(); root.hidden = !pendingImportFiles.length;
  pendingImportFiles.forEach((entry) => {
    const card = document.createElement("div"); card.className = `import-file ${entry.status}`;
    const icon = document.createElement("i"); icon.textContent = entry.status === "ready" ? "✓" : entry.status === "failed" ? "!" : "…";
    const copy = document.createElement("span"); const name = document.createElement("strong"); name.textContent = entry.name; const detail = document.createElement("small"); detail.textContent = entry.detail; copy.append(name, detail);
    const tag = document.createElement("input"); tag.value = entry.accountTag || ""; tag.placeholder = "Account tag"; tag.disabled = entry.status !== "ready"; tag.setAttribute("aria-label", `Account tag for ${entry.name}`);
    tag.addEventListener("input", () => { entry.accountTag = tag.value; entry.rows.forEach((row) => { row.accountTag = tag.value; }); });
    card.append(icon, copy, tag); root.append(card);
  });
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
  const text = $("#batch-input").value.trim(); if (!text) return $("#batch-input").focus(); if (batchMatching) return;
  batchMatching = true; setButtonLoading($("#batch-submit"), true); $("#batch-input").disabled = true;
  try {
    const result = await api("/api/reviews/batch", { method: "POST", body: JSON.stringify({ text }) });
    const matched = new Set(result.matched.map(String)); const matchedItems = items.filter((item) => matched.has(item.id));
    matchedItems.forEach((item) => { if (result.categories?.[item.id]) item.category = result.categories[item.id]; });
    items = items.filter((item) => !matched.has(item.id)); reviewedCount += matchedItems.length; syncQueue(); $("#batch-result").hidden = false;
    const assigned = [...new Set(Object.values(result.categories || {}))];
    $("#batch-result-text").textContent = matchedItems.length ? `Matched ${matchedItems.length} payment${matchedItems.length === 1 ? "" : "s"}${assigned.length ? ` as ${assigned.join(" and ")}` : ""}. ${items.length} remain.` : "No confident matches yet. Try a category, an amount such as ₹450, or a range such as under ₹1,000.";
    if (!items.length) setTimeout(renderReview, 850);
  } catch (error) { showToast("Couldn’t apply explanation", error.message); }
  finally { batchMatching = false; setButtonLoading($("#batch-submit"), false); $("#batch-input").disabled = false; }
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
  const selected = [...(event.target.files || [])]; if (!selected.length) return;
  const oversized = selected.find((file) => file.size > 20_000_000); if (oversized) return showToast(`${oversized.name} is too large`, "Use files under 20 MB each");
  pendingImport = []; pendingImportFiles = selected.map((file) => ({ name: file.name, status: "waiting", detail: "Waiting to parse", accountTag: "", rows: [] })); renderImportFiles();
  $("#import-loading").hidden = false; $("#import-preview").hidden = true; $("#import-submit").disabled = true;
  for (let index = 0; index < selected.length; index++) {
    const file = selected[index]; const entry = pendingImportFiles[index]; entry.status = "parsing"; entry.detail = "Opening file…"; renderImportFiles();
    try {
      const isPDF = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"); let result;
      if (isPDF) result = await parsePDF(file, (page, pages, metadata) => {
        const fileProgress = pages ? page / pages : 0; const overall = (index + fileProgress) / selected.length;
        $("#import-progress-title").textContent = `Parsing ${file.name}`; $("#import-progress-detail").textContent = `Page ${Math.min(page + 1, pages)} of ${pages} · ${metadata}`; $("#import-progress-bar").style.width = `${overall * 100}%`;
        entry.detail = `Page ${Math.min(page + 1, pages)} of ${pages} · ${metadata}`; renderImportFiles();
      });
      else { $("#import-progress-title").textContent = `Parsing ${file.name}`; $("#import-progress-detail").textContent = "Detecting columns, account, debit rows, and references"; result = parseCSV(await file.text(), file); }
      entry.rows = result.rows; entry.accountTag = result.accountTag; entry.detail = result.detail; entry.status = result.rows.length ? "ready" : "failed"; pendingImport.push(...result.rows); renderImportFiles();
    } catch (error) { entry.status = "failed"; entry.detail = error.message || "Could not read this file"; renderImportFiles(); }
    $("#import-progress-bar").style.width = `${((index + 1) / selected.length) * 100}%`;
  }
  $("#import-loading").hidden = true; $("#import-preview").hidden = false;
  const readyFiles = pendingImportFiles.filter((file) => file.status === "ready").length;
  $("#import-count").textContent = pendingImport.length ? `${pendingImport.length} transactions ready` : "No debit transactions detected";
  $("#import-filename").textContent = `${readyFiles} of ${selected.length} files parsed · account tags remain editable`;
  $("#import-submit").disabled = !pendingImport.length;
});
$("#clear-import")?.addEventListener("click", () => { pendingImport = []; pendingImportFiles = []; $("#statement-file").value = ""; $("#import-preview").hidden = true; $("#import-files").hidden = true; $("#import-submit").disabled = true; });
$("#import-submit")?.addEventListener("click", async () => {
  try { const result = await api("/api/transactions/import", { method: "POST", body: JSON.stringify({ transactions: pendingImport }) }); dialogs.import.close(); showToast(`${result.imported} transactions imported`, `${result.verified || 0} verified across statements · ${result.duplicates || 0} repeats skipped`); await loadDashboard(); }
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
