const $ = (selector) => document.querySelector(selector);
const formatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const dialog = $("#transaction-dialog");
const form = $("#transaction-form");
const defaultCategories = ["Food & dining", "Groceries", "Travel", "Shopping", "Bills", "Health", "Entertainment", "Subscriptions", "Education", "Personal care", "Home", "Gifts", "Insurance", "Investments", "Taxes", "Transfers", "Work"];
let transactions = [];
let currentPage = 1;
let totalPages = 1;
let loadSequence = 0;
const pageSize = 25;
let availableCategories = [...defaultCategories];

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function toast(title, detail) {
  const element = $(".toast"); element.querySelector("strong").textContent = title; element.querySelector("small").textContent = detail;
  element.classList.add("visible"); setTimeout(() => element.classList.remove("visible"), 2600);
}

function statusLabel(status) {
  return ({ unresolved: "Needs review", explained: "Explained", known: "Known / repeat", deferred: "Deferred", auto_resolved: "Auto resolved" })[status] || status;
}

function updateCategorySuggestions(values = []) {
  availableCategories = [...new Set([...defaultCategories, ...values].map((value) => String(value || "").trim()).filter((value) => value && value.toLowerCase() !== "uncategorised"))].sort((left, right) => left.localeCompare(right));
  renderCategoryMenu();
}

function renderCategoryMenu(query = "") {
  const menu = $("#category-suggestions"); const value = query.trim().toLowerCase(); const visible = availableCategories.filter((category) => !value || category.toLowerCase().includes(value));
  menu.replaceChildren(...visible.map((category) => { const button = document.createElement("button"); button.type = "button"; button.role = "option"; button.textContent = category; button.addEventListener("click", () => { $("#transaction-category").value = category; toggleCategoryMenu(false); }); return button; }));
  if (!visible.length) { const empty = document.createElement("small"); empty.textContent = "Keep typing to create this category."; menu.append(empty); }
}

function toggleCategoryMenu(open) {
  $("#category-suggestions").hidden = !open; $("#show-categories").setAttribute("aria-expanded", String(open));
}

function render(data) {
  const visible = transactions; const root = $("#ledger-rows"); root.replaceChildren();
  root.setAttribute("aria-busy", "false");
  for (const item of visible) {
    const row = document.createElement("div"); row.className = "ledger-row"; row.setAttribute("role", "row");
    const merchant = document.createElement("span"); merchant.className = "ledger-merchant";
    const icon = document.createElement("i"); icon.textContent = item.merchant.slice(0, 2).toUpperCase();
    const copy = document.createElement("span"); const strong = document.createElement("strong"); strong.textContent = item.merchant;
    const date = document.createElement("small"); const dateOptions = item.timeVerified ? { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" }; const occurred = new Date(item.occurredAt).toLocaleString("en-IN", dateOptions); date.textContent = item.accountTag ? `${occurred} · ${item.accountTag}` : occurred;
    copy.append(strong, date); merchant.append(icon, copy);
    const category = document.createElement("span"); category.textContent = item.category || "Uncategorised";
    const status = document.createElement("span"); const pill = document.createElement("i"); pill.className = `status-tag ${item.reviewStatus}`; pill.textContent = statusLabel(item.reviewStatus); status.append(pill);
    const amount = document.createElement("strong"); amount.className = "ledger-amount"; amount.textContent = formatter.format(item.amount);
    const actions = document.createElement("span"); actions.className = "row-actions";
    if (item.reviewStatus === "unresolved") { const review = document.createElement("a"); review.href = `/?review=${encodeURIComponent(item.id)}`; review.textContent = "Review"; actions.append(review); }
    const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit"; edit.addEventListener("click", () => openEditor(item)); actions.append(edit);
    row.append(merchant, category, status, amount, actions); root.append(row);
  }
  $("#ledger-count").textContent = `${data.total} transaction${data.total === 1 ? "" : "s"}`; $("#ledger-total").textContent = formatter.format(Number(data.totalAmountPaise || 0) / 100);
  $("#ledger-empty").hidden = Boolean(visible.length); $(".ledger-table").hidden = !visible.length;
  totalPages = data.pages; currentPage = data.page;
  const start = data.total ? (currentPage - 1) * data.pageSize + 1 : 0; const end = Math.min(data.total, currentPage * data.pageSize);
  $("#ledger-page").textContent = `Page ${currentPage} of ${totalPages}`; $("#ledger-range").textContent = data.total ? `Showing ${start}–${end} of ${data.total}` : "No transactions to show";
  $("#ledger-previous").disabled = currentPage <= 1; $("#ledger-next").disabled = currentPage >= totalPages;
  $("#ledger-pagination").hidden = !visible.length || data.total <= data.pageSize;
}

function showLedgerLoading() {
  const root = $("#ledger-rows"); root.setAttribute("aria-busy", "true"); root.replaceChildren(); $(".ledger-table").hidden = false; $("#ledger-empty").hidden = true; $("#ledger-pagination").hidden = true;
  for (let index = 0; index < 5; index++) {
    const row = document.createElement("div"); row.className = "ledger-row ledger-skeleton"; row.setAttribute("aria-hidden", "true");
    const merchant = document.createElement("span"); merchant.className = "ledger-merchant"; const avatar = document.createElement("i"); avatar.className = "skeleton-avatar"; const copy = document.createElement("span");
    const line = document.createElement("b"); line.className = "skeleton-line medium"; const subline = document.createElement("b"); subline.className = "skeleton-line short"; copy.append(line, subline); merchant.append(avatar, copy);
    row.append(merchant, ...["medium", "short", "short", "medium"].map((size) => { const span = document.createElement("span"); span.className = `skeleton-line ${size}`; return span; })); root.append(row);
  }
}

function localDateParts(value, timeVerified = true) {
  const date = new Date(value); const offset = date.getTimezoneOffset(); const local = new Date(date.getTime() - offset * 60000).toISOString();
  return { date: local.slice(0, 10), time: timeVerified ? local.slice(11, 16) : "" };
}

function openEditor(item = null) {
  form.reset(); toggleCategoryMenu(false); $("#form-error").hidden = true; form.elements.id.value = item?.id || "";
  $("#editor-eyebrow").textContent = item ? "EDIT TRANSACTION" : "NEW TRANSACTION"; $("#editor-title").textContent = item ? "Update this payment." : "Add a payment.";
  $("#delete-transaction").hidden = !item;
  if (item) {
    form.elements.merchant.value = item.merchant; form.elements.amount.value = item.amount;
    const occurred = localDateParts(item.occurredAt, item.timeVerified); form.elements.occurredDate.value = occurred.date; form.elements.occurredTime.value = occurred.time;
    form.elements.category.value = item.category && item.category.toLowerCase() !== "uncategorised" ? item.category : "";
    form.elements.accountTag.value = item.accountTag || "";
    form.elements.reviewStatus.value = item.reviewStatus; form.elements.description.value = item.description || ""; form.elements.context.value = item.context || "";
  } else { const occurred = localDateParts(new Date()); form.elements.occurredDate.value = occurred.date; form.elements.occurredTime.value = occurred.time; }
  dialog.showModal(); setTimeout(() => form.elements.merchant.focus(), 0);
}

async function load() {
  const sequence = ++loadSequence; showLedgerLoading();
  try {
    const params = new URLSearchParams({ page: String(currentPage), pageSize: String(pageSize), search: $("#transaction-search").value.trim(), status: $("#status-filter").value, category: $("#category-filter").value }); window.PaisaDateWindow.query($("#transactions-date-window")).forEach((value, key) => params.set(key, value));
    const data = await api(`/api/transactions?${params}`); if (sequence !== loadSequence) return;
    if (currentPage > data.pages) { currentPage = data.pages; return load(); }
    transactions = data.transactions;
    const selectedCategory = $("#category-filter").value; $("#category-filter").replaceChildren(new Option("All categories", "all"), ...data.categories.map((value) => new Option(value, value))); $("#category-filter").value = data.categories.includes(selectedCategory) ? selectedCategory : "all"; updateCategorySuggestions(data.categories);
    render(data);
    if (!$("[data-profile-name]").dataset.loaded) {
      const bootstrap = await api("/api/bootstrap"); if (sequence !== loadSequence) return;
      document.querySelectorAll("[data-inbox-count]").forEach((node) => node.textContent = bootstrap.summary.count);
      $("[data-profile-name]").textContent = bootstrap.user.name || "My account"; $("[data-profile-email]").textContent = bootstrap.user.email || "Private account"; $("[data-profile-name]").dataset.loaded = "true";
    }
  } catch (error) {
    $("#ledger-rows").replaceChildren(); $("#ledger-rows").setAttribute("aria-busy", "false");
    $("#ledger-count").textContent = "Transactions unavailable"; $("#ledger-total").textContent = "";
    toast("Couldn’t load transactions", error.message);
  }
}

let searchTimer;
$("#transaction-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { currentPage = 1; load(); }, 250); });
[$("#status-filter"), $("#category-filter")].forEach((input) => input.addEventListener("change", () => { currentPage = 1; load(); }));
$("#ledger-previous").addEventListener("click", () => { if (currentPage > 1) { currentPage--; load(); } });
$("#ledger-next").addEventListener("click", () => { if (currentPage < totalPages) { currentPage++; load(); } });
window.PaisaDateWindow.setup($("#transactions-date-window"), () => { currentPage = 1; load(); });
document.querySelectorAll("[data-add-transaction]").forEach((button) => button.addEventListener("click", () => openEditor()));
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => dialog.close()));
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
$("#show-categories").addEventListener("click", () => { const input = $("#transaction-category"); const open = $("#category-suggestions").hidden; renderCategoryMenu(); toggleCategoryMenu(open); input.focus(); });
$("#transaction-category").addEventListener("focus", (event) => { if (event.currentTarget.value.toLowerCase() === "uncategorised") event.currentTarget.value = ""; });
$("#transaction-category").addEventListener("input", (event) => { renderCategoryMenu(event.currentTarget.value); toggleCategoryMenu(true); });
document.addEventListener("click", (event) => { if (!event.target.closest(".category-control")) toggleCategoryMenu(false); });
form.addEventListener("submit", async (event) => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(form)); const id = values.id; delete values.id;
  values.category = String(values.category || "").trim() || "Uncategorised";
  const localTimestamp = `${values.occurredDate}T${values.occurredTime || "12:00"}:00`; const parsedDate = new Date(localTimestamp);
  values.occurredAt = parsedDate.toISOString(); values.timeVerified = Boolean(values.occurredTime); delete values.occurredDate; delete values.occurredTime;
  const button = $("#save-transaction"); button.disabled = true; button.textContent = "Saving…";
  try {
    await api(id ? `/api/transactions/${encodeURIComponent(id)}` : "/api/transactions", { method: id ? "PUT" : "POST", body: JSON.stringify(values) });
    dialog.close(); toast(id ? "Transaction updated" : "Transaction added", "Dashboard and insights are now in sync"); await load();
  } catch (error) { $("#form-error").textContent = error.message; $("#form-error").hidden = false; }
  finally { button.disabled = false; button.textContent = "Save transaction"; }
});
$("#delete-transaction").addEventListener("click", async () => {
  const id = form.elements.id.value; if (!id || !confirm("Delete this transaction permanently?")) return;
  try { await api(`/api/transactions/${encodeURIComponent(id)}`, { method: "DELETE" }); dialog.close(); toast("Transaction deleted", "It has been removed from your dashboard and insights"); await load(); }
  catch (error) { $("#form-error").textContent = error.message; $("#form-error").hidden = false; }
});
$("[data-menu]")?.addEventListener("click", () => $(".sidebar")?.classList.toggle("open"));
updateCategorySuggestions();
