const $ = (selector) => document.querySelector(selector);
const formatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const colors = ["#df8b65", "#5f8f87", "#d4a646", "#7685a8", "#8eaa73", "#b67e9c", "#76a4ad", "#b39869"];

async function api(path) { const response = await fetch(path); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Request failed"); return data; }

function showLoading() {
  const line = (classes) => `<span class="skeleton-line ${classes}"></span>`;
  [["#insight-total", "metric-line"], ["#insight-count", "medium"], ["#insight-average", "metric-line"], ["#insight-understood", "metric-line"], ["#insight-unresolved", "medium"]].forEach(([selector, classes]) => { $(selector).innerHTML = line(classes); });
  const bars = $("#daily-bars"); bars.classList.add("insight-skeleton-bars"); bars.setAttribute("aria-busy", "true"); bars.innerHTML = [34, 58, 42, 76, 52, 88, 64].map((height) => `<div><small>${line("short")}</small><i style="height:${height}%"></i>${line("tiny")}</div>`).join("");
  const categories = $("#insight-categories"); categories.setAttribute("aria-busy", "true"); categories.innerHTML = Array.from({ length: 4 }, () => `<div class="insight-category insight-category-skeleton"><div>${line("medium")}${line("short")}</div><div><i></i></div></div>`).join("");
  const health = $("#review-health"); health.setAttribute("aria-busy", "true"); health.innerHTML = Array.from({ length: 3 }, () => `<div class="review-health-skeleton">${line("medium")}${line("short")}</div>`).join("");
}

async function load() {
  showLoading();
  try {
    const query = window.PaisaDateWindow.query($("#insights-date-window")).toString(); const suffix = query ? `?${query}` : "";
    const [data, bootstrap] = await Promise.all([api(`/api/insights${suffix}`), api(`/api/bootstrap${suffix}`)]); const period = $("#insights-date-window [data-window-select]"); $("#insight-period-label").textContent = (period?.options[period.selectedIndex]?.textContent || "Selected period").toUpperCase();
    $("#insight-total").textContent = formatter.format(data.totals.amountPaise / 100); $("#insight-count").textContent = `${data.totals.count} payments tracked`;
    $("#insight-average").textContent = formatter.format(data.totals.averagePaise / 100);
    const unresolved = data.statuses.find((item) => item.status === "unresolved")?.count || 0; const understood = data.totals.count ? Math.round(((data.totals.count - unresolved) / data.totals.count) * 100) : 100;
    $("#insight-understood").textContent = `${understood}%`; $("#insight-unresolved").textContent = unresolved ? `${unresolved} still need context` : "Everything is understood";
    document.querySelectorAll("[data-inbox-count]").forEach((node) => node.textContent = bootstrap.summary.count); $("[data-profile-name]").textContent = bootstrap.user.name || "My account"; $("[data-profile-email]").textContent = bootstrap.user.email || "Private account";

    const days = data.days.slice(-30); const maxDay = Math.max(1, ...days.map((item) => item.amountPaise)); const bars = $("#daily-bars"); bars.replaceChildren(); bars.classList.remove("insight-skeleton-bars"); bars.setAttribute("aria-busy", "false");
    if (!days.length) bars.textContent = "Import transactions to see your spending rhythm.";
    for (const item of days) {
      const column = document.createElement("div"); const amount = document.createElement("small"); amount.textContent = formatter.format(item.amountPaise / 100);
      const bar = document.createElement("i"); bar.style.height = `${Math.max(5, (item.amountPaise / maxDay) * 100)}%`;
      const day = document.createElement("span"); day.textContent = new Date(`${item.day}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); column.append(amount, bar, day); bars.append(column);
    }
    const categoryRoot = $("#insight-categories"); categoryRoot.replaceChildren(); categoryRoot.setAttribute("aria-busy", "false"); const maxCategory = Math.max(1, ...data.categories.map((item) => item.amountPaise));
    data.categories.forEach((item, index) => {
      const row = document.createElement("div"); row.className = "insight-category"; const top = document.createElement("div");
      const name = document.createElement("strong"); name.textContent = item.name; const value = document.createElement("span"); value.textContent = `${formatter.format(item.amountPaise / 100)} · ${item.count}`; top.append(name, value);
      const track = document.createElement("div"); const fill = document.createElement("i"); fill.style.width = `${(item.amountPaise / maxCategory) * 100}%`; fill.style.background = colors[index % colors.length]; track.append(fill); row.append(top, track); categoryRoot.append(row);
    });
    const health = $("#review-health"); health.replaceChildren(); health.setAttribute("aria-busy", "false");
    data.statuses.forEach((item) => { const row = document.createElement("div"); const label = document.createElement("span"); label.textContent = item.status.replaceAll("_", " "); const count = document.createElement("strong"); count.textContent = item.count; row.append(label, count); health.append(row); });
  } catch (error) {
    ["#daily-bars", "#insight-categories", "#review-health"].forEach((selector) => { const root = $(selector); root.replaceChildren(); root.setAttribute("aria-busy", "false"); });
    $("#daily-bars").textContent = "Insights are temporarily unavailable.";
    const toast = $(".toast"); toast.querySelector("small").textContent = error.message; toast.classList.add("visible");
  }
}
window.PaisaDateWindow.setup($("#insights-date-window"), () => load());
