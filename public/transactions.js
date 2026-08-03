const $ = (selector) => document.querySelector(selector);
const formatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const dialog = $("#transaction-dialog");
const form = $("#transaction-form");
let transactions = [];

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

function filtered() {
  const query = $("#transaction-search").value.trim().toLowerCase();
  const status = $("#status-filter").value; const category = $("#category-filter").value;
  return transactions.filter((item) => (!query || `${item.merchant} ${item.description || ""} ${item.context || ""} ${item.accountTag || ""}`.toLowerCase().includes(query)) && (status === "all" || item.reviewStatus === status) && (category === "all" || item.category === category));
}

function render() {
  const visible = filtered(); const root = $("#ledger-rows"); root.replaceChildren();
  root.setAttribute("aria-busy", "false");
  for (const item of visible) {
    const row = document.createElement("div"); row.className = "ledger-row"; row.setAttribute("role", "row");
    const merchant = document.createElement("span"); merchant.className = "ledger-merchant";
    const icon = document.createElement("i"); icon.textContent = item.merchant.slice(0, 2).toUpperCase();
    const copy = document.createElement("span"); const strong = document.createElement("strong"); strong.textContent = item.merchant;
    const date = document.createElement("small"); const occurred = new Date(item.occurredAt).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }); date.textContent = item.accountTag ? `${occurred} · ${item.accountTag}` : occurred;
    copy.append(strong, date); merchant.append(icon, copy);
    const category = document.createElement("span"); category.textContent = item.category || "Uncategorised";
    const status = document.createElement("span"); const pill = document.createElement("i"); pill.className = `status-tag ${item.reviewStatus}`; pill.textContent = statusLabel(item.reviewStatus); status.append(pill);
    const amount = document.createElement("strong"); amount.className = "ledger-amount"; amount.textContent = formatter.format(item.amount);
    const actions = document.createElement("span"); actions.className = "row-actions";
    if (item.reviewStatus === "unresolved") { const review = document.createElement("a"); review.href = `/?review=${encodeURIComponent(item.id)}`; review.textContent = "Review"; actions.append(review); }
    const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit"; edit.addEventListener("click", () => openEditor(item)); actions.append(edit);
    row.append(merchant, category, status, amount, actions); root.append(row);
  }
  const total = visible.reduce((sum, item) => sum + Number(item.amountPaise || 0), 0);
  $("#ledger-count").textContent = `${visible.length} transaction${visible.length === 1 ? "" : "s"}`; $("#ledger-total").textContent = formatter.format(total / 100);
  $("#ledger-empty").hidden = Boolean(visible.length); $(".ledger-table").hidden = !visible.length;
}

function toLocalDate(value) {
  const date = new Date(value); const offset = date.getTimezoneOffset(); return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
}

function openEditor(item = null) {
  form.reset(); $("#form-error").hidden = true; form.elements.id.value = item?.id || "";
  $("#editor-eyebrow").textContent = item ? "EDIT TRANSACTION" : "NEW TRANSACTION"; $("#editor-title").textContent = item ? "Update this payment." : "Add a payment.";
  $("#delete-transaction").hidden = !item;
  if (item) {
    form.elements.merchant.value = item.merchant; form.elements.amount.value = item.amount;
    form.elements.occurredAt.value = toLocalDate(item.occurredAt); form.elements.category.value = item.category || "";
    form.elements.accountTag.value = item.accountTag || "";
    form.elements.reviewStatus.value = item.reviewStatus; form.elements.description.value = item.description || ""; form.elements.context.value = item.context || "";
  } else form.elements.occurredAt.value = toLocalDate(new Date());
  dialog.showModal(); setTimeout(() => form.elements.merchant.focus(), 0);
}

async function load() {
  try {
    const data = await api("/api/transactions"); transactions = data.transactions;
    const categories = [...new Set(transactions.map((item) => item.category).filter(Boolean))].sort();
    $("#category-filter").replaceChildren(new Option("All categories", "all"), ...categories.map((value) => new Option(value, value)));
    render();
    const bootstrap = await api("/api/bootstrap"); document.querySelectorAll("[data-inbox-count]").forEach((node) => node.textContent = bootstrap.summary.count);
    $("[data-profile-name]").textContent = bootstrap.user.name || "My account"; $("[data-profile-email]").textContent = bootstrap.user.email || "Private account";
  } catch (error) {
    $("#ledger-rows").replaceChildren(); $("#ledger-rows").setAttribute("aria-busy", "false");
    $("#ledger-count").textContent = "Transactions unavailable"; $("#ledger-total").textContent = "";
    toast("Couldn’t load transactions", error.message);
  }
}

[$("#transaction-search"), $("#status-filter"), $("#category-filter")].forEach((input) => input.addEventListener("input", render));
document.querySelectorAll("[data-add-transaction]").forEach((button) => button.addEventListener("click", () => openEditor()));
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => dialog.close()));
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
form.addEventListener("submit", async (event) => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(form)); const id = values.id; delete values.id;
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
load();
