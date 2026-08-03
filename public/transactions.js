const $ = (selector) => document.querySelector(selector);
const formatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const dialog = $("#transaction-dialog");
const form = $("#transaction-form");
const defaultCategories = ["Food & dining", "Groceries", "Travel", "Shopping", "Bills", "Loans & EMI", "Health", "Entertainment", "Subscriptions", "Education", "Personal care", "Home", "Gifts", "Insurance", "Investments", "Taxes", "Transfers", "Work"];
let transactions = [];
let currentPage = 1;
let totalPages = 1;
let loadSequence = 0;
const pageSize = 25;
let availableCategories = [...defaultCategories];
let paymentAccounts = [];
let loans = [];
const selectedIDs = new Set();

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

function displayMerchant(value) {
  const cleaned = String(value || "").replace(/^\s*\d{6,}[\s/:.-]*/u, "").replace(/\s+\d{8,}\s*$/u, "").trim();
  return cleaned || "Payment";
}

function merchantMark(value) {
  const letters = String(value || "").match(/[\p{L}]/gu) || [];
  return letters.slice(0, 2).join("").toUpperCase() || "₹";
}

function updateCategorySuggestions(values = []) {
  availableCategories = [...new Set([...defaultCategories, ...values].map((value) => String(value || "").trim()).filter((value) => value && value.toLowerCase() !== "uncategorised"))].sort((left, right) => left.localeCompare(right));
  renderCategoryMenu();
}

function renderCategoryMenu(query = "") {
  const menu = $("#category-suggestions"); const value = query.trim().toLowerCase(); const visible = availableCategories.filter((category) => !value || category.toLowerCase().includes(value));
  menu.replaceChildren(...visible.map((category) => { const button = document.createElement("button"); button.type = "button"; button.role = "option"; button.textContent = category; button.addEventListener("click", () => { $("#transaction-category").value = category; toggleCategoryMenu(false); toggleLoanAllocation(); }); return button; }));
  if (!visible.length) { const empty = document.createElement("small"); empty.textContent = "Keep typing to create this category."; menu.append(empty); }
}

function toggleCategoryMenu(open) {
  $("#category-suggestions").hidden = !open; $("#show-categories").setAttribute("aria-expanded", String(open));
}

function renderPaymentAccounts(selected = "") {
  const select = $("#transaction-account"); if (!select) return; const value = selected || select.value;
  if (value && !paymentAccounts.some((account) => account.name === value)) paymentAccounts.push({ id: "legacy", name: value, kind: "other", lastFour: "" });
  select.replaceChildren(new Option("No payment account", ""), ...paymentAccounts.map((account) => new Option(`${account.name}${account.lastFour ? ` · •••• ${account.lastFour}` : ""}`, account.name))); select.value = value;
}

function isLoanCategory(value = "") { return /\b(?:loan|emi|instalment|installment)\b/i.test(value); }
function renderLoans(selected = "") {
  const select = $("#transaction-loan"); if (!select) return; const value = selected || select.value;
  select.replaceChildren(new Option("Choose a loan or EMI plan", ""), ...loans.map((loan) => new Option(`${loan.name}${loan.status !== "active" ? ` · ${loan.status}` : ""}`, loan.id))); select.value = value;
}
function toggleLoanAllocation() { const shown = isLoanCategory(form.elements.category.value); $("#loan-allocation").hidden = !shown; if (!shown) { form.elements.loanId.value = ""; form.elements.emiNumber.value = ""; form.elements.principalComponent.value = ""; form.elements.interestComponent.value = ""; } }

function render(data) {
  const visible = transactions; const root = $("#ledger-rows"); root.replaceChildren();
  root.setAttribute("aria-busy", "false");
  for (const item of visible) {
    const row = document.createElement("div"); row.className = "ledger-row"; row.setAttribute("role", "row");
    const merchant = document.createElement("span"); merchant.className = "ledger-merchant";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = selectedIDs.has(item.id); checkbox.setAttribute("aria-label", `Select ${item.merchant}`);
    checkbox.addEventListener("click", (event) => event.stopPropagation()); checkbox.addEventListener("change", () => { checkbox.checked ? selectedIDs.add(item.id) : selectedIDs.delete(item.id); updateBulkToolbar(); });
    const shownMerchant = displayMerchant(item.merchant); const icon = document.createElement("i"); icon.textContent = merchantMark(shownMerchant);
    const copy = document.createElement("span"); const strong = document.createElement("strong"); strong.textContent = shownMerchant;
    const date = document.createElement("small"); const dateOptions = item.timeVerified ? { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" }; const occurred = new Date(item.occurredAt).toLocaleString("en-IN", dateOptions); date.textContent = item.accountTag ? `${occurred} · ${item.accountTag}` : occurred;
    copy.append(strong, date); merchant.append(checkbox, icon, copy);
    const category = document.createElement("span"); category.className = "quick-category";
    const categorySelect = document.createElement("select"); categorySelect.setAttribute("aria-label", `Category for ${item.merchant}`);
    const currentCategory = item.category || "Uncategorised"; const categoryValues = [...new Set(["Uncategorised", ...availableCategories, currentCategory])];
    categorySelect.replaceChildren(...categoryValues.map((value) => new Option(value, value))); categorySelect.value = currentCategory;
    categorySelect.addEventListener("change", async () => { const previous = item.category; categorySelect.disabled = true; try { await api(`/api/transactions/${encodeURIComponent(item.id)}/category`, { method: "PATCH", body: JSON.stringify({ category: categorySelect.value }) }); item.category = categorySelect.value; toast("Category updated", `${item.merchant} is now ${item.category}`); } catch (error) { categorySelect.value = previous || "Uncategorised"; toast("Couldn’t update category", error.message); } finally { categorySelect.disabled = false; } });
    category.append(categorySelect);
    const status = document.createElement("span"); const pill = document.createElement("i"); pill.className = `status-tag ${item.reviewStatus}`; pill.textContent = statusLabel(item.reviewStatus); status.append(pill);
    const amount = document.createElement("strong"); amount.className = "ledger-amount"; amount.textContent = formatter.format(item.amount);
    const actions = document.createElement("span"); actions.className = "row-actions";
    if (item.reviewStatus === "unresolved") { const review = document.createElement("button"); review.type = "button"; review.textContent = "Review"; review.addEventListener("click", () => window.PaisaQuickReview?.open(item.id)); actions.append(review); }
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
  $("#select-page").checked = visible.length > 0 && visible.every((item) => selectedIDs.has(item.id)); updateBulkToolbar();
}

function updateBulkToolbar() {
  $("#selected-count").textContent = String(selectedIDs.size); $("#bulk-toolbar").hidden = !selectedIDs.size;
  $("#select-page").indeterminate = selectedIDs.size > 0 && !transactions.every((item) => selectedIDs.has(item.id));
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
  $("#transaction-advanced").open = Boolean(item);
  $("#editor-eyebrow").textContent = item ? "EDIT TRANSACTION" : "NEW TRANSACTION"; $("#editor-title").textContent = item ? "Update this payment." : "Add a payment.";
  $("#delete-transaction").hidden = !item;
  if (item) {
    form.elements.merchant.value = item.merchant; form.elements.amount.value = item.amount;
    const occurred = localDateParts(item.occurredAt, item.timeVerified); form.elements.occurredDate.value = occurred.date; form.elements.occurredTime.value = occurred.time;
    form.elements.category.value = item.category && item.category.toLowerCase() !== "uncategorised" ? item.category : "";
    form.elements.accountTag.value = item.accountTag || "";
    form.elements.reviewStatus.value = item.reviewStatus; form.elements.description.value = item.description || ""; form.elements.context.value = item.context || ""; form.elements.loanId.value = item.loanId || ""; form.elements.emiNumber.value = item.emiNumber || ""; form.elements.principalComponent.value = Number(item.principalComponentPaise || 0) / 100 || ""; form.elements.interestComponent.value = Number(item.interestComponentPaise || 0) / 100 || "";
  } else { const occurred = localDateParts(new Date()); form.elements.occurredDate.value = occurred.date; form.elements.occurredTime.value = occurred.time; if (paymentAccounts.length === 1) form.elements.accountTag.value = paymentAccounts[0].name; }
  renderLoans(form.elements.loanId.value); toggleLoanAllocation(); dialog.showModal(); setTimeout(() => form.elements.merchant.focus(), 0);
}

async function load() {
  const sequence = ++loadSequence; showLedgerLoading();
  try {
    const params = new URLSearchParams({ page: String(currentPage), pageSize: String(pageSize), search: $("#transaction-search").value.trim(), status: $("#status-filter").value, category: $("#category-filter").value }); window.PaisaDateWindow.query($("#transactions-date-window")).forEach((value, key) => params.set(key, value));
    const [data, accountData, loanData] = await Promise.all([api(`/api/transactions?${params}`), api("/api/payment-accounts"), api("/api/loans")]); if (sequence !== loadSequence) return; paymentAccounts = accountData.accounts || []; loans = loanData.loans || []; renderPaymentAccounts(); renderPaymentAccountManager(); renderLoans(); renderLoanManager();
    if (currentPage > data.pages) { currentPage = data.pages; return load(); }
    transactions = data.transactions;
    const selectedCategory = $("#category-filter").value; $("#category-filter").replaceChildren(new Option("Any category", "all"), ...data.categories.map((value) => new Option(value, value))); $("#category-filter").value = data.categories.includes(selectedCategory) ? selectedCategory : "all"; updateCategorySuggestions(data.categories);
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
$("#select-page").addEventListener("change", (event) => {
  transactions.forEach((item) => event.currentTarget.checked ? selectedIDs.add(item.id) : selectedIDs.delete(item.id));
  $("#ledger-rows").querySelectorAll('input[type="checkbox"]').forEach((checkbox) => { checkbox.checked = event.currentTarget.checked; }); updateBulkToolbar();
});
$("#clear-selection").addEventListener("click", () => { selectedIDs.clear(); transactions.forEach(() => {}); load(); });
$("#delete-selected").addEventListener("click", async () => {
  if (!selectedIDs.size || !confirm(`Delete ${selectedIDs.size} selected transaction${selectedIDs.size === 1 ? "" : "s"}?`)) return;
  const button = $("#delete-selected"); button.disabled = true; button.textContent = "Deleting…";
  try { const result = await api("/api/transactions/batch", { method: "DELETE", body: JSON.stringify({ ids: [...selectedIDs] }) }); selectedIDs.clear(); toast(`${result.deleted} deleted`, "Dashboard and insights are updated"); await load(); }
  catch (error) { toast("Couldn’t delete selected transactions", error.message); }
  finally { button.disabled = false; button.textContent = "Delete selected"; }
});
window.PaisaDateWindow.setup($("#transactions-date-window"), () => { currentPage = 1; load(); });
document.querySelectorAll("[data-add-transaction]").forEach((button) => button.addEventListener("click", () => openEditor()));
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => dialog.close()));
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
$("#show-categories").addEventListener("click", () => { const input = $("#transaction-category"); const open = $("#category-suggestions").hidden; renderCategoryMenu(); toggleCategoryMenu(open); input.focus(); });
$("#transaction-category").addEventListener("focus", (event) => { if (event.currentTarget.value.toLowerCase() === "uncategorised") event.currentTarget.value = ""; });
$("#transaction-category").addEventListener("input", (event) => { renderCategoryMenu(event.currentTarget.value); toggleCategoryMenu(true); toggleLoanAllocation(); });
document.addEventListener("click", (event) => { if (!event.target.closest(".category-control")) toggleCategoryMenu(false); });
form.addEventListener("submit", async (event) => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(form)); const id = values.id; delete values.id;
  values.category = String(values.category || "").trim() || "Uncategorised";
  if (isLoanCategory(values.category) && !values.loanId) { $("#form-error").textContent = "Choose the loan or EMI plan this payment belongs to, or create one now."; $("#form-error").hidden = false; $("#loan-allocation").hidden = false; return; }
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
const accountDialog = $("#account-dialog"), accountForm = $("#account-form");
function resetPaymentAccountForm() { accountForm.reset(); accountForm.elements.id.value = ""; }
function renderPaymentAccountManager() {
  const root = $("#payment-account-list"); if (!root) return;
  root.replaceChildren(...paymentAccounts.map((account) => {
    const row = document.createElement("article"); row.className = "entity-row";
    const copy = document.createElement("span"); const strong = document.createElement("strong"); strong.textContent = account.name; const small = document.createElement("small"); small.textContent = [account.kind.replace("_", " "), account.institution, account.lastFour && `•••• ${account.lastFour}`].filter(Boolean).join(" · "); copy.append(strong, small);
    const actions = document.createElement("span"); const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit"; edit.addEventListener("click", () => { for (const key of ["id","name","kind","institution","lastFour"]) accountForm.elements[key].value = account[key] || ""; accountForm.elements.name.focus(); });
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger-link"; remove.textContent = "Delete"; remove.addEventListener("click", async () => { if (!confirm(`Delete ${account.name}?`)) return; try { await api(`/api/payment-accounts/${account.id}`, { method: "DELETE" }); paymentAccounts = paymentAccounts.filter((item) => item.id !== account.id); renderPaymentAccounts(); renderPaymentAccountManager(); toast("Payment method deleted", "It is gone everywhere"); } catch (error) { toast("Couldn’t delete payment method", error.message); } });
    actions.append(edit, remove); row.append(copy, actions); return row;
  }));
}
function openAccountManager(fresh = false) { if (fresh) resetPaymentAccountForm(); renderPaymentAccountManager(); accountDialog.showModal(); }
$("#new-payment-account")?.addEventListener("click", () => openAccountManager(true));
$("#manage-payment-accounts")?.addEventListener("click", () => openAccountManager());
$("#reset-payment-account")?.addEventListener("click", resetPaymentAccountForm);
document.querySelectorAll("[data-close-account]").forEach((button) => button.addEventListener("click", () => accountDialog.close()));
accountDialog?.addEventListener("click", (event) => { if (event.target === accountDialog) accountDialog.close(); });
accountForm?.addEventListener("submit", async (event) => { event.preventDefault(); const button = event.submitter; const values = Object.fromEntries(new FormData(accountForm)); button.disabled = true; try { const result = await api(values.id ? `/api/payment-accounts/${values.id}` : "/api/payment-accounts", { method: values.id ? "PUT" : "POST", body: JSON.stringify(values) }); paymentAccounts = [...paymentAccounts.filter((account) => account.id !== result.account.id), result.account].sort((left, right) => left.name.localeCompare(right.name)); renderPaymentAccounts(result.account.name); renderPaymentAccountManager(); resetPaymentAccountForm(); toast("Payment method saved", "Available everywhere transactions are edited"); } catch (error) { toast("Couldn’t save payment method", error.message); } finally { button.disabled = false; } });

const loanDialog = $("#loan-dialog"), loanForm = $("#loan-form");
function resetLoanForm(prefill = {}) { loanForm.reset(); loanForm.elements.id.value = ""; for (const [key, value] of Object.entries(prefill)) if (loanForm.elements[key]) loanForm.elements[key].value = value ?? ""; updateNoCostFields(); $("#loan-form-error").hidden = true; }
function renderLoanManager() {
  const root = $("#loan-list"); if (!root) return;
  root.replaceChildren(...loans.map((loan) => {
    const row = document.createElement("article"); row.className = "entity-row"; const copy = document.createElement("span"); const strong = document.createElement("strong"); strong.textContent = loan.name; const small = document.createElement("small"); small.textContent = [loan.lender, loan.noCostEmi ? "No-cost EMI" : `${loan.interestRate || 0}% p.a.`, loan.emiAmountPaise ? `${formatter.format(loan.emiAmountPaise / 100)} EMI` : "", loan.outstandingPaise ? `${formatter.format(loan.outstandingPaise / 100)} outstanding` : "", loan.linkedEmiCount ? `${loan.linkedEmiCount} linked payment${loan.linkedEmiCount===1?"":"s"}` : "", loan.status].filter(Boolean).join(" · "); copy.append(strong, small);
    const actions = document.createElement("span"); const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit"; edit.addEventListener("click", () => { const values = { id:loan.id,name:loan.name,lender:loan.lender,loanType:loan.loanType,accountNumber:loan.accountNumber,principal:loan.principalPaise/100||"",outstanding:loan.outstandingPaise/100||"",emiAmount:loan.emiAmountPaise/100||"",tenureMonths:loan.tenureMonths||"",interestRate:loan.interestRate||"",totalInterest:loan.totalInterestPaise/100||"",processingFee:loan.processingFeePaise/100||"",status:loan.status,startDate:loan.startDate||"",nextDueDate:loan.nextDueDate||"" }; for (const [key,value] of Object.entries(values)) loanForm.elements[key].value=value; loanForm.elements.noCostEmi.checked=loan.noCostEmi; updateNoCostFields(); loanForm.elements.name.focus(); });
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger-link"; remove.textContent = "Delete"; remove.addEventListener("click", async () => { if (!confirm(`Delete ${loan.name}?`)) return; try { await api(`/api/loans/${loan.id}`, {method:"DELETE"}); loans=loans.filter((item)=>item.id!==loan.id); renderLoans(); renderLoanManager(); toast("Loan deleted", "It is gone everywhere"); } catch(error){ toast("Couldn’t delete loan",error.message); } }); actions.append(edit,remove); row.append(copy,actions); return row;
  }));
}
function updateNoCostFields(){ const noCost=loanForm.elements.noCostEmi.checked; for(const name of ["interestRate","totalInterest"]){ loanForm.elements[name].disabled=noCost; if(noCost) loanForm.elements[name].value="0"; } }
function openLoanManager(prefill = null){ if(prefill) resetLoanForm(prefill); renderLoanManager(); loanDialog.showModal(); }
$("#manage-loans")?.addEventListener("click",()=>openLoanManager());
$("#new-loan")?.addEventListener("click",()=>openLoanManager({name:form.elements.merchant.value ? `${form.elements.merchant.value} EMI` : "",lender:form.elements.merchant.value||"",emiAmount:form.elements.amount.value||""}));
$("#reset-loan")?.addEventListener("click",()=>resetLoanForm());
loanForm?.elements.noCostEmi.addEventListener("change",updateNoCostFields);
document.querySelectorAll("[data-close-loan]").forEach((button)=>button.addEventListener("click",()=>loanDialog.close()));
loanDialog?.addEventListener("click",(event)=>{if(event.target===loanDialog)loanDialog.close();});
loanForm?.addEventListener("submit",async(event)=>{event.preventDefault();const button=event.submitter,values=Object.fromEntries(new FormData(loanForm));values.noCostEmi=loanForm.elements.noCostEmi.checked;button.disabled=true;try{const result=await api(values.id?`/api/loans/${values.id}`:"/api/loans",{method:values.id?"PUT":"POST",body:JSON.stringify(values)});loans=[...loans.filter((loan)=>loan.id!==result.loan.id),result.loan].sort((a,b)=>a.name.localeCompare(b.name));renderLoans(result.loan.id);renderLoanManager();resetLoanForm();loanDialog.close();if(dialog.open){form.elements.loanId.value=result.loan.id;$("#loan-allocation").hidden=false;}toast("Loan saved","EMI payments can now be linked to it");}catch(error){$("#loan-form-error").textContent=error.message;$("#loan-form-error").hidden=false;}finally{button.disabled=false;}});
$("#loan-pdf")?.addEventListener("change",async(event)=>{const file=event.currentTarget.files?.[0];if(!file)return;const label=event.currentTarget.closest("label");label.classList.add("parsing");try{const pdfjs=await import("/vendor/pdf.mjs");pdfjs.GlobalWorkerOptions.workerSrc="/vendor/pdf.worker.mjs";const pdf=await pdfjs.getDocument({data:await file.arrayBuffer()}).promise;let text="";for(let page=1;page<=pdf.numPages;page++){const content=await (await pdf.getPage(page)).getTextContent();text+=` ${content.items.map((item)=>item.str).join(" ")}`;}const {parseLoanText}=await import("/loan-parser.mjs");const parsed=parseLoanText(text);for(const [key,value] of Object.entries(parsed)){if(key==="noCostEmi")loanForm.elements.noCostEmi.checked=Boolean(value);else if(loanForm.elements[key]&&value!=="")loanForm.elements[key].value=value;}updateNoCostFields();toast("Loan PDF parsed","Review the extracted terms before saving");}catch(error){$("#loan-form-error").textContent=`Couldn’t read this PDF: ${error.message}`;$("#loan-form-error").hidden=false;}finally{label.classList.remove("parsing");event.currentTarget.value="";}});
document.addEventListener("paisa:transactions-changed",()=>load());
if(new URLSearchParams(location.search).get("newLoan")==="1")setTimeout(()=>openLoanManager({}),0);
updateCategorySuggestions();
