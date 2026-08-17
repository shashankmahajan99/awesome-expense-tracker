const list = document.querySelector("#bank-connections"), form = document.querySelector("#aa-connect-form"), statusNode = document.querySelector("#aa-form-status"), refreshButton = document.querySelector("#refresh-connections");

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload.error || "Request failed"); error.code = payload.code; error.existingId = payload.existingId; throw error; }
  return payload;
}

function line(label, value) { const row = document.createElement("div"), term = document.createElement("dt"), detail = document.createElement("dd"); term.textContent = label; detail.textContent = value || "—"; row.append(term, detail); return row; }
function date(value) { return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value.endsWith?.("Z") ? value : `${value.replace(" ", "T")}Z`)) : "Not yet"; }
function message(text, tone = "") { statusNode.textContent = text; statusNode.className = `form-status ${tone}`; }

function renderConnection(item) {
  const card = document.createElement("article"); card.className = "connection-card"; card.dataset.id = item.id;
  const top = document.createElement("div"), copy = document.createElement("div"), title = document.createElement("strong"), meta = document.createElement("small"), pill = document.createElement("span");
  title.textContent = item.provider; meta.textContent = `Mobile ending ${item.mobileLastFour || "••••"}`; pill.className = `consent-status ${item.status.toLowerCase()}`; pill.textContent = item.status; copy.append(title, meta); top.append(copy, pill);
  const facts = document.createElement("dl"); facts.append(line("Purpose", item.purpose), line("Refresh", item.frequency), line("Last synced", date(item.lastSyncedAt)), line("Expires", date(item.expiresAt)));
  const actions = document.createElement("div"); actions.className = "connection-actions";
  if (item.consentUrl) { const continueLink = document.createElement("a"); continueLink.className = "primary-button"; continueLink.href = item.consentUrl; continueLink.rel = "noreferrer"; continueLink.textContent = "Continue with Setu →"; actions.append(continueLink); }
  const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "secondary-button"; refresh.dataset.action = "refresh"; refresh.textContent = "Check status"; actions.append(refresh);
  if (!["REVOKED", "REJECTED", "EXPIRED"].includes(item.status)) { const revoke = document.createElement("button"); revoke.type = "button"; revoke.className = "danger-button"; revoke.dataset.action = "revoke"; revoke.textContent = "Disconnect & revoke"; actions.append(revoke); }
  if (item.lastError) { const error = document.createElement("p"); error.className = "connection-error"; error.textContent = item.lastError; card.append(top, facts, error, actions); } else card.append(top, facts, actions);
  return card;
}

async function loadConnections(refreshReturned = false) {
  try {
    const data = await api("/api/bank-connections"); list.replaceChildren(); list.setAttribute("aria-busy", "false");
    if (!data.configured) { form.querySelector("button").disabled = true; const note = document.createElement("div"); note.className = "connection-empty setup"; note.innerHTML = "<strong>Setu onboarding is not configured yet.</strong><span>The product flow is ready; production credentials and a verified webhook must be added before users can connect a bank.</span>"; list.append(note); return; }
    if (!data.connections.length) { const empty = document.createElement("div"); empty.className = "connection-empty"; empty.innerHTML = "<strong>No bank connected yet.</strong><span>Your imported statements continue to work while you decide.</span>"; list.append(empty); return; }
    data.connections.forEach((item) => list.append(renderConnection(item)));
    if (refreshReturned) { const current = data.connections.find((item) => ["PENDING", "INITIATED"].includes(item.status)); if (current) await runAction(current.id, "refresh"); }
  } catch (error) { list.textContent = error.message; list.setAttribute("aria-busy", "false"); }
}

async function runAction(id, action) {
  const button = list.querySelector(`[data-id="${CSS.escape(id)}"] [data-action="${action}"]`); if (button) button.disabled = true;
  if (action === "revoke" && !confirm("Stop future bank sync and revoke this Account Aggregator consent? Existing Paisa transactions stay until you delete them.")) { if (button) button.disabled = false; return; }
  try { await api(`/api/bank-connections/${encodeURIComponent(id)}/${action}`, { method: "POST" }); await loadConnections(); }
  catch (error) { message(error.message, "error"); if (button) button.disabled = false; }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault(); const button = form.querySelector("button"); button.disabled = true; message("Preparing your consent request…");
  try { const data = await api("/api/bank-connections/setu/consents", { method: "POST", body: JSON.stringify({ mobile: new FormData(form).get("mobile") }) }); message("Opening Setu’s secure consent screen.", "success"); location.assign(data.consentUrl); }
  catch (error) { message(error.message, "error"); button.disabled = false; if (error.existingId) await loadConnections(); }
});
list.addEventListener("click", (event) => { const button = event.target.closest("[data-action]"); const card = button?.closest("[data-id]"); if (button && card) runAction(card.dataset.id, button.dataset.action); });
refreshButton.addEventListener("click", () => loadConnections());
loadConnections(new URLSearchParams(location.search).has("setu"));
