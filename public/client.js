const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const dialogs = { review: $("#review-dialog"), batch: $("#batch-dialog"), preferences: $("#preferences-dialog"), reset: $("#reset-dialog"), completion: $("#completion-dialog"), import: $("#import-dialog") };
const formatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const tones = ["amber", "red", "blue", "green", "yellow"];
const defaultCategories = ["Food & dining", "Groceries", "Travel", "Shopping", "Bills", "Loans & EMI", "Health", "Entertainment", "Subscriptions", "Education", "Personal care", "Home", "Gifts", "Insurance", "Investments", "Taxes", "Transfers", "Work"];
let items = [];
let current = 0;
let reviewedCount = 0;
let preferences = null;
let pendingImport = [];
let pendingImportFiles = [];
let activeRecognition = null;
let reviewSaving = false;
let batchMatching = false;
let paymentAccounts = [];
let loans = [];

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

function categorySuggestion(value = "") {
  const text = String(value).toLowerCase();
  const rules = [
    ["Food & dining", /zomato|swiggy|restaurant|cafe|coffee|domino|pizza|burger|kitchen/],
    ["Groceries", /blinkit|zepto|bigbasket|instamart|grocery|supermarket/],
    ["Travel", /uber|ola|rapido|metro|railway|irctc|airlines|flight|petrol|diesel|fuel|indian oil|parking|toll/],
    ["Shopping", /amazon|flipkart|myntra|ajio|retail|store/],
    ["Loans & EMI", /\bloan\b|\bemi\b|instalment|installment/],
    ["Bills", /electricity|broadband|airtel|jio|vodafone|recharge|utility|rent|dcc fee|service fee|annual fee/],
    ["Health", /hospital|pharmacy|medical|apollo|doctor|clinic|medicine/],
    ["Entertainment", /xsolla|steam|playstation|netflix|spotify|hotstar|cinema|bookmyshow|gaming|game/],
    ["Taxes", /\bigst\b|\bgst\b|\btax\b/],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || "Uncategorised";
}

function mapTransaction(transaction, index) {
  const merchant = transaction.merchant || "Unknown payment";
  const storedCategory = transaction.category || "Uncategorised";
  const category = storedCategory.toLowerCase() === "uncategorised" ? categorySuggestion(`${merchant} ${transaction.description || ""}`) : storedCategory;
  const dateOptions = transaction.timeVerified ? { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" };
  return {
    id: String(transaction.id), merchant,
    meta: new Date(transaction.occurredAt).toLocaleString("en-IN", dateOptions),
    amount: formatter.format(Number(transaction.amountPaise || 0) / 100),
    icon: merchant.slice(0, 2).toUpperCase(), tone: tones[index % tones.length],
    status: "Needs context", detail: category.toLowerCase() !== "uncategorised" ? `Suggested category: ${category}` : "Choose a category or add a quick note",
    occurredAt: transaction.occurredAt, timeVerified: Boolean(transaction.timeVerified), amountPaise: Number(transaction.amountPaise || 0), category,
    description: transaction.description, context: transaction.context, reviewStatus: transaction.reviewStatus, accountTag: transaction.accountTag || "", loanId: transaction.loanId || "", emiNumber: transaction.emiNumber, principalComponentPaise: transaction.principalComponentPaise || 0, interestComponentPaise: transaction.interestComponentPaise || 0,
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
  arrangeDashboardPanels();
}

function arrangeDashboardPanels() {
  const side = $("#dashboard-side"), bottom = $("#activity"), categories = $("#dashboard-categories-card"), focus = $("#dashboard-focus-card");
  if (!side || !bottom || !categories || !focus) return;
  const useSide = matchMedia("(min-width: 1051px)").matches && items.length >= 4;
  (useSide ? side : bottom).append(categories, focus); bottom.hidden = useSide;
}
addEventListener("resize", arrangeDashboardPanels);

function renderReview() {
  if (!items.length) {
    dialogs.review?.close(); dialogs.batch?.close(); syncQueue();
    $("#completed-count").textContent = String(reviewedCount);
    dialogs.completion?.showModal(); return;
  }
  current = Math.min(current, items.length - 1);
  const item = items[current];
  $("#review-position").textContent = String(current + 1); $("#review-total").textContent = String(items.length);
  $("#review-previous").disabled = current <= 0; $("#review-next").disabled = current >= items.length - 1;
  $("#review-progress").style.width = `${((current + 1) / items.length) * 100}%`;
  $("#review-icon").textContent = item.icon; $("#review-icon").className = `merchant-icon ${item.tone} large`;
  $("#review-meta").textContent = item.meta.toUpperCase(); $("#review-amount").textContent = item.amount; $("#review-merchant").textContent = item.merchant;
  $("#review-question").textContent = item.merchant === "Indian Oil" ? "Was this fuel or travel?" : `What should you remember about ${item.merchant}?`;
  $("#review-hint").textContent = item.category && item.category.toLowerCase() !== "uncategorised" ? `We suggested ${item.category}. Change it if needed, then add an optional note.` : "Choose a category. Add a note only if it will help you understand this later."; $("#answer-input").value = item.context || "";
  const date = new Date(item.occurredAt), local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString();
  $("#review-edit-merchant").value = item.merchant; $("#review-edit-amount").value = String(item.amountPaise / 100); $("#review-edit-date").value = local.slice(0, 10); $("#review-edit-time").value = item.timeVerified ? local.slice(11, 16) : "";
  const account = $("#review-edit-account"); account.replaceChildren(new Option("No payment account", ""), ...paymentAccounts.map((value) => new Option(value.name, value.name))); if (item.accountTag && !paymentAccounts.some((value) => value.name === item.accountTag)) account.append(new Option(item.accountTag, item.accountTag)); account.value = item.accountTag || "";
  const loan=$("#review-loan");loan.replaceChildren(new Option("Choose a loan or EMI plan",""),...loans.map((value)=>new Option(value.name,value.id)));loan.value=item.loanId||"";$("#review-emi-number").value=item.emiNumber||"";$("#review-principal-component").value=item.principalComponentPaise/100||"";$("#review-interest-component").value=item.interestComponentPaise/100||"";
  populateReviewCategories(item.category);
  toggleReviewLoan();
}

function populateReviewCategories(selected = "Uncategorised") {
  const select = $("#review-category"); const categories = [...new Set([...defaultCategories, ...items.map((item) => item.category).filter(Boolean), selected].filter(Boolean))].sort();
  select.replaceChildren(...categories.map((value) => new Option(value, value)), new Option("Add a new category…", "__custom")); select.value = categories.includes(selected) ? selected : "Uncategorised"; $("#review-category-custom").hidden = true;
  const chips = $("#review-category-chips"); chips?.replaceChildren(...defaultCategories.slice(0, 8).map((value) => { const button = document.createElement("button"); button.type = "button"; button.textContent = value; button.classList.toggle("active", value === selected); button.addEventListener("click", () => { select.value = value; $("#review-category-custom").hidden = true; chips.querySelectorAll("button").forEach((node) => node.classList.toggle("active", node === button)); toggleReviewLoan(); }); return button; }));
}

function reviewCategory() { const selected = $("#review-category").value; return selected === "__custom" ? $("#review-category-custom").value.trim() || "Uncategorised" : selected || "Uncategorised"; }
function toggleReviewLoan(){$("#review-loan-allocation").hidden=!/\b(?:loan|emi|instalment|installment)\b/i.test(reviewCategory());}

function openReview(id) {
  if (id) current = Math.max(0, items.findIndex((item) => item.id === String(id)));
  renderReview(); dialogs.review?.showModal();
}

function moveReview(direction) { if (!items.length || reviewSaving) return; current = Math.max(0, Math.min(items.length - 1, current + direction)); stopVoice(); renderReview(); }

async function resolveCurrent(action, message, context = "") {
  const item = items[current];
  if (!item || reviewSaving) return;
  reviewSaving = true; const button = action === "explain" ? $("#submit-answer") : $(`[data-action="${action}"]`); setButtonLoading(button, true);
  try {
    const category = reviewCategory(); const merchant = $("#review-edit-merchant").value.trim(); const amount = Number($("#review-edit-amount").value); const occurredDate = $("#review-edit-date").value; const occurredTime = $("#review-edit-time").value;
    if (!merchant || !amount || !occurredDate) throw new Error("Merchant, amount, and date are required");
    const occurredAt = new Date(`${occurredDate}T${occurredTime || "12:00"}:00`).toISOString();
    const needsLoan=/\b(?:loan|emi|instalment|installment)\b/i.test(category);if(needsLoan&&!$("#review-loan").value)throw new Error("Choose which loan or EMI plan this payment belongs to");
    await api(`/api/transactions/${encodeURIComponent(item.id)}`, { method: "PUT", body: JSON.stringify({ merchant, amount, occurredAt, timeVerified: Boolean(occurredTime), category, context, description: item.description || "", accountTag: $("#review-edit-account").value, reviewStatus: item.reviewStatus,loanId:needsLoan?$("#review-loan").value:"",emiNumber:$("#review-emi-number").value,principalComponent:$("#review-principal-component").value,interestComponent:$("#review-interest-component").value }) });
    await api(`/api/transactions/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ action, context, category }) }); item.category = category;
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
  $("#focus-detail").textContent = topCategory ? `${topCategory.count} payment${topCategory.count === 1 ? "" : "s"} make it your largest tracked category.` : "Paisa Inbox will turn your imported statement into a clear daily inbox.";
}

function showDashboardLoading() {
  const line = (classes) => `<span class="skeleton-line ${classes}"></span>`;
  $("#hero-title").innerHTML = `${line("hero-heading")}${line("hero-heading medium")}`;
  $("#hero-summary").innerHTML = `${line("wide")}${line("medium")}`;
  $("#review-estimate").innerHTML = line("short");
  $$('[data-open-review]').forEach((button) => { button.disabled = true; button.classList.add("loading-control"); });
  [["#tracked-total", "metric-line"], ["#understood-percent", "metric-line"], ["#largest-payment", "metric-line"], ["#tracked-count", "medium"], ["#understood-detail", "medium"], ["#largest-detail", "medium"]].forEach(([selector, classes]) => { $(selector).innerHTML = line(classes); });
  [["#visual-total", "skeleton-disc"], ["#visual-understood", "skeleton-disc small"], ["#visual-largest", "skeleton-disc small"], ["#visual-unresolved", "skeleton-disc small"]].forEach(([selector, classes]) => { $(selector).innerHTML = `<i class="${classes}"></i>`; });
  $("#transaction-list").setAttribute("aria-busy", "true");
  $("#transaction-list").innerHTML = Array.from({ length: 4 }, () => `<div class="transaction skeleton-row" aria-hidden="true"><span class="skeleton-avatar"></span><span>${line("medium")}${line("short")}</span><span>${line("medium")}${line("short")}</span>${line("amount-line")}</div>`).join("");
  $("#snapshot-total").innerHTML = line("metric-line"); $("#snapshot-caption").innerHTML = line("short");
  $("#snapshot-bars").classList.add("skeleton-bars"); $("#snapshot-bars").setAttribute("aria-busy", "true");
  $("#snapshot-bars").innerHTML = [30, 52, 42, 69, 55, 82, 64].map((height) => `<div><i style="height:${height}%"></i>${line("tiny")}</div>`).join("");
  $("#snapshot-note").innerHTML = `<span>✦</span><p>${line("wide")}${line("medium")}</p>`;
  $("#dashboard-categories").setAttribute("aria-busy", "true");
  $("#dashboard-categories").innerHTML = Array.from({ length: 4 }, () => `<div class="category skeleton-category"><div><span class="skeleton-dot"></span>${line("medium")}${line("short")}</div><div class="track"><i></i></div></div>`).join("");
  $("#focus-title").innerHTML = `${line("wide dark")}${line("medium dark")}`; $("#focus-detail").innerHTML = `${line("wide dark")}${line("medium dark")}`;
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
  const suggestion = value.includes("paytm") ? (bank ? `Paytm - Savings ${bank}` : "Paytm Wallet") : value.includes("rupay") ? (bank ? `RuPay Card - ${bank}` : "RuPay Card") : (value.includes("credit card") || value.includes("card statement")) ? (bank ? `Credit Card - ${bank}` : "Credit Card") : (bank ? `Savings - ${bank}` : "Bank account");
  const scored = paymentAccounts.map((account) => ({ account, score: [account.name, account.institution, ...(account.aliases || [])].filter(Boolean).reduce((total, candidate) => total + (value.includes(String(candidate).toLowerCase()) || suggestion.toLowerCase().includes(String(candidate).toLowerCase()) ? String(candidate).length : 0), 0) })).sort((left, right) => right.score - left.score);
  return scored[0]?.score ? scored[0].account.name : "";
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
    const date = statementDate(value(dateIndex));
    return { occurredAt: date?.occurredAt, timeVerified: date?.timeVerified || false, merchant: value(merchantIndex), description: value(merchantIndex), amount, category: categoryIndex >= 0 ? value(categoryIndex) || "Uncategorised" : "Uncategorised", accountTag, sourceFile: file.name, source, reference: value(referenceIndex), credit: hasCreditOnly || /\b(cr|credit)\b/.test(type) };
  }).filter((item) => item.occurredAt && item.merchant && item.amount > 0 && !item.credit);
  return { rows: parsed, accountTag, detail: `${parsed.length} debit rows · ${headers.length} columns detected` };
}

function statementDate(value) {
  const fullISO = value.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/i);
  if (fullISO) { const parsed = new Date(fullISO[0]); if (!Number.isNaN(parsed.getTime())) return { occurredAt: parsed.toISOString(), timeVerified: true }; }
  const time = value.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?\b/i);
  const build = (year, month, day) => {
    let hour = time ? Number(time[1]) : 12; const minute = time ? Number(time[2]) : 0; const meridiem = time?.[3]?.toUpperCase();
    if (meridiem === "PM" && hour < 12) hour += 12; if (meridiem === "AM" && hour === 12) hour = 0;
    const date = new Date(year, month - 1, day, hour, minute); return Number.isNaN(date.getTime()) ? null : { occurredAt: date.toISOString(), timeVerified: Boolean(time) };
  };
  const iso = value.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/); if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const named = value.match(/\b(\d{1,2})[- ](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[- ](\d{2,4})\b/i);
  if (named) { const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(named[2].toLowerCase()) + 1; return build(Number(named[3].length === 2 ? `20${named[3]}` : named[3]), month, Number(named[1])); }
  const match = value.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/); if (!match) return null;
  return build(Number(match[3].length === 2 ? `20${match[3]}` : match[3]), Number(match[2]), Number(match[1]));
}

async function parseStatementText(lines, file) {
  const { parseStatementRecords } = await import("/statement-parser.mjs?v=2");
  const accountTag = accountTagFor(file.name, lines.slice(0, 80).join(" ")); const source = importSource(file.name, accountTag);
  const rows = parseStatementRecords(lines, { filename: file.name, accountTag, source, parseDate: statementDate });
  return { rows, accountTag, detail: `${rows.length} debit rows · ${lines.length} text rows reconstructed` };
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
    [...byLine.entries()].sort((a, b) => b[0] - a[0]).forEach(([, itemsOnLine]) => { const sorted = itemsOnLine.sort((a, b) => (a.transform?.[4] || 0) - (b.transform?.[4] || 0)); let line = "", right = 0; for (const item of sorted) { const x = item.transform?.[4] || 0; if (line && x - right > 18) line += " | "; else if (line) line += " "; line += item.str; right = x + (item.width || 0); } lines.push(line); });
    onProgress?.(pageNumber, document.numPages, `${lines.length} text rows detected`);
  }
  return await parseStatementText(lines, file);
}

function renderImportFiles() {
  const root = $("#import-files"); root.replaceChildren(); root.hidden = !pendingImportFiles.length;
  pendingImportFiles.forEach((entry) => {
    const card = document.createElement("div"); card.className = `import-file ${entry.status}`;
    const icon = document.createElement("i"); icon.textContent = entry.status === "ready" ? "✓" : entry.status === "failed" ? "!" : "…";
    const copy = document.createElement("span"); const name = document.createElement("strong"); name.textContent = entry.name; const detail = document.createElement("small"); detail.textContent = entry.detail; copy.append(name, detail);
    const tag = document.createElement("select"); tag.className = "payment-account-picker"; tag.replaceChildren(new Option(entry.status === "ready" ? "Choose saved account" : "Waiting for parser", ""), ...paymentAccounts.map((account) => new Option(`${account.name}${account.lastFour ? ` · •••• ${account.lastFour}` : ""}`, account.name))); tag.value = entry.accountTag || ""; tag.disabled = entry.status !== "ready"; tag.setAttribute("aria-label", `Payment account for ${entry.name}`);
    tag.addEventListener("change", () => { entry.accountTag = tag.value; entry.rows.forEach((row) => { row.accountTag = tag.value; }); $("#import-submit").disabled = !pendingImport.length || pendingImportFiles.some((file) => file.status === "ready" && !file.accountTag); });
    card.append(icon, copy, tag); root.append(card);
  });
}

async function loadDashboard() {
  try {
    const query = window.PaisaDateWindow.query($("#dashboard-date-window")).toString(); const suffix = query ? `?${query}` : "";
    const [data, insights] = await Promise.all([api(`/api/bootstrap${suffix}`), api(`/api/insights${suffix}`)]);
    items = data.transactions.map(mapTransaction); paymentAccounts = data.accounts || []; loans=data.loans||[]; reviewedCount = 0; syncQueue(); applyPreferences(data.preferences);
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
$("#review-previous")?.addEventListener("click", () => moveReview(-1));
$("#review-next")?.addEventListener("click", () => moveReview(1));
let reviewDragStart = null;
dialogs.review?.addEventListener("pointerdown", (event) => { if (event.target.closest("button,input,select,textarea,summary")) return; reviewDragStart = event.clientX; });
dialogs.review?.addEventListener("pointerup", (event) => { if (reviewDragStart === null) return; const delta = event.clientX - reviewDragStart; reviewDragStart = null; if (delta < -70) moveReview(1); else if (delta > 70) moveReview(-1); });
$("#submit-answer")?.addEventListener("click", () => resolveCurrent("explain", "Review saved", $("#answer-input").value.trim()));
$("#answer-input")?.addEventListener("keydown", (event) => { if (event.key === "Enter") resolveCurrent("explain", "Review saved", event.currentTarget.value.trim()); });
dialogs.review?.addEventListener("keydown", (event) => { if (event.target?.matches("input,select,textarea")) return; if (event.key === "ArrowLeft") moveReview(-1); if (event.key === "ArrowRight") moveReview(1); });
$$('[data-action]').forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.action === "defer") resolveCurrent("defer", "Saved for later");
  else if (button.dataset.action === "known") resolveCurrent("known", "Marked as known");
  else { const merchant = items[current]?.merchant || ""; dialogs.review.close(); $("#batch-input").value = `${merchant} was part of `; dialogs.batch.showModal(); $("#batch-input").focus(); }
}));
$("#voice-button")?.addEventListener("click", () => startVoice($("#answer-input"), $("#voice-button")));
$("#review-category")?.addEventListener("change", (event) => { const custom = $("#review-category-custom"); custom.hidden = event.currentTarget.value !== "__custom"; if (!custom.hidden) custom.focus(); toggleReviewLoan(); });
$("#review-category-custom")?.addEventListener("input",toggleReviewLoan);

function populateBatchCategories() { const select = $("#batch-category"); if (!select) return; const chosen = select.value; const values = [...new Set([...defaultCategories, ...items.map((item) => item.category).filter((value) => value && value !== "Uncategorised")])].sort(); select.replaceChildren(new Option("Infer from what I wrote", ""), ...values.map((value) => new Option(value, value))); select.value = values.includes(chosen) ? chosen : ""; }
$$('[data-open-batch]').forEach((button) => button.addEventListener("click", () => { $("#batch-result").hidden = true; $("#batch-input").value = ""; populateBatchCategories(); dialogs.batch.showModal(); }));
$$('[data-close-batch]').forEach((button) => button.addEventListener("click", () => { stopVoice(); dialogs.batch.close(); }));
$("#batch-voice")?.addEventListener("click", () => startVoice($("#batch-input"), $("#batch-voice")));
$("#batch-submit")?.addEventListener("click", async () => {
  const text = $("#batch-input").value.trim(); if (!text) return $("#batch-input").focus(); if (batchMatching) return;
  batchMatching = true; setButtonLoading($("#batch-submit"), true); $("#batch-input").disabled = true;
  try {
    const result = await api("/api/reviews/batch", { method: "POST", body: JSON.stringify({ text, category: $("#batch-category")?.value || "" }) });
    const matched = new Set(result.matched.map(String)); const matchedItems = items.filter((item) => matched.has(item.id));
    matchedItems.forEach((item) => { if (result.categories?.[item.id]) item.category = result.categories[item.id]; });
    items = items.filter((item) => !matched.has(item.id)); reviewedCount += matchedItems.length; syncQueue(); $("#batch-result").hidden = false;
    const assigned = [...new Set(Object.values(result.categories || {}))];
    $("#batch-result-text").textContent = matchedItems.length ? `Matched ${matchedItems.length} payment${matchedItems.length === 1 ? "" : "s"}${assigned.length ? ` as ${assigned.join(" and ")}` : ""}. ${items.length} remain.` : "No confident matches yet. Try a category, an amount such as ₹450, or a range such as under ₹1,000.";
    if (!items.length) setTimeout(renderReview, 850);
  } catch (error) { showToast("Couldn’t apply explanation", error.message); }
  finally { batchMatching = false; setButtonLoading($("#batch-submit"), false); $("#batch-input").disabled = false; }
});

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
$("#reset-financial-data")?.addEventListener("click", () => dialogs.reset.showModal());
$("#cancel-reset")?.addEventListener("click", () => dialogs.reset.close());
$("#confirm-reset")?.addEventListener("click", async () => {
  const button = $("#confirm-reset"); button.disabled = true; button.textContent = "Clearing…";
  try { const result = await api("/api/transactions", { method: "DELETE" }); dialogs.reset.close(); dialogs.preferences.close(); items = []; syncQueue(); showToast(`${result.deleted} transactions cleared`, "You can now import statements with the updated parser"); await loadDashboard(); }
  catch (error) { showToast("Reset failed", error.message); }
  finally { button.disabled = false; button.textContent = "Delete all transactions"; }
});
$("#delete-account")?.addEventListener("click", async () => {
  if (!window.confirm("Permanently delete all Paisa Inbox transactions, reviews, preferences, and audit data for this account? This cannot be undone.")) return;
  try { await api("/api/account", { method: "DELETE" }); dialogs.preferences.close(); items = []; syncQueue(); showToast("Account data deleted", "Your Paisa Inbox records have been permanently removed"); }
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
  $("#import-submit").disabled = !pendingImport.length || pendingImportFiles.some((file) => file.status === "ready" && !file.accountTag);
});
$("#clear-import")?.addEventListener("click", () => { pendingImport = []; pendingImportFiles = []; $("#statement-file").value = ""; $("#import-preview").hidden = true; $("#import-files").hidden = true; $("#import-submit").disabled = true; });
$("#import-submit")?.addEventListener("click", async () => {
  try { const result = await api("/api/transactions/import", { method: "POST", body: JSON.stringify({ transactions: pendingImport }) }); dialogs.import.close(); showToast(`${result.imported} transactions imported`, `${result.verified || 0} verified across statements · ${result.duplicates || 0} repeats skipped`); await loadDashboard(); }
  catch (error) { showToast("Import failed", error.message); }
});

$$('[data-close-completion]').forEach((button) => button.addEventListener("click", () => dialogs.completion.close()));
Object.values(dialogs).filter(Boolean).forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target === dialog) { stopVoice(); dialog.close(); } }));
const params = new URLSearchParams(location.search);
if (["preferences", "import", "review"].some((key) => params.has(key))) history.replaceState({}, "", `${location.pathname}${location.hash}`);
if (params.has("import")) dialogs.import?.showModal();
if (params.has("review")) setTimeout(() => openReview(params.get("review")), 400);
window.PaisaDateWindow.setup($("#dashboard-date-window"), () => { showDashboardLoading(); loadDashboard(); });
