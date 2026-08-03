(() => {
  const root = document.documentElement, savedTheme = localStorage.getItem("paisa-theme") || "system";
  const effectiveTheme = (value) => value === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : value;
  const updateThemeButtons = (value) => document.querySelectorAll("[data-toggle-theme]").forEach((button) => { const next = effectiveTheme(value) === "dark" ? "light" : "dark"; button.setAttribute("aria-label", `Use ${next} mode`); button.title = `Use ${next} mode`; });
  const applyTheme = (value) => { root.dataset.theme = value; root.style.colorScheme = value === "system" ? "light dark" : value; document.querySelector('meta[name="theme-color"]')?.setAttribute("content", effectiveTheme(value) === "dark" ? "#101815" : "#f4f1e9"); updateThemeButtons(value); };
  applyTheme(savedTheme);
  const preferences = document.querySelector("#global-preferences-dialog"), profile = document.querySelector("#global-profile-dialog"), form = document.querySelector("#global-preferences-form");
  const open = (dialog) => { if (dialog && !dialog.open) dialog.showModal(); };
  document.querySelectorAll("[data-open-preferences]").forEach((button) => button.addEventListener("click", () => open(preferences)));
  document.querySelectorAll("[data-open-profile]").forEach((button) => button.addEventListener("click", () => open(profile)));
  document.querySelectorAll("[data-close-global]").forEach((button) => button.addEventListener("click", () => button.closest("dialog")?.close()));
  document.querySelectorAll("[data-toggle-theme]").forEach((button) => button.addEventListener("click", () => { const next = effectiveTheme(root.dataset.theme || "system") === "dark" ? "light" : "dark"; localStorage.setItem("paisa-theme", next); if (form) form.elements.appearance.value = next; applyTheme(next); }));
  [preferences, profile].forEach((dialog) => dialog?.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); }));
  if (form) {
    form.elements.appearance.value = savedTheme; form.elements.companionConsent.checked = localStorage.getItem("paisa-companion-consent") === "yes";
    form.elements.appearance.addEventListener("change", (event) => applyTheme(event.target.value));
    form.addEventListener("submit", async (event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(form)); localStorage.setItem("paisa-theme", values.appearance); localStorage.setItem("paisa-companion-consent", form.elements.companionConsent.checked ? "yes" : "no"); applyTheme(values.appearance); try { await fetch("/api/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...values, weeklyCleanup: true, quietStart: "23:00", quietEnd: "07:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) }); } catch {} preferences.close(); });
  }
  fetch("/api/bootstrap").then((response) => response.ok ? response.json() : null).then((data) => { if (!data) return; const name = data.user?.name || "My account", email = data.user?.email || "Private account"; document.querySelectorAll("[data-profile-name]").forEach((node) => node.textContent = name); document.querySelectorAll("[data-profile-email]").forEach((node) => node.textContent = email); document.querySelectorAll("[data-profile-initials]").forEach((node) => node.textContent = name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "PI"); document.querySelectorAll("[data-inbox-count]").forEach((node) => { if (node.querySelector(".skeleton-count")) node.textContent = String(data.summary?.count || 0); }); }).catch(() => {});
  const sidebar = document.querySelector(".sidebar"), backdrop = document.querySelector("[data-sidebar-backdrop]"); const setMenu = (openMenu) => { sidebar?.classList.toggle("open", openMenu); if (backdrop) backdrop.hidden = !openMenu; document.body.classList.toggle("menu-open", openMenu); };
  document.querySelectorAll("[data-menu]").forEach((button) => button.addEventListener("click", () => setMenu(!sidebar?.classList.contains("open")))); backdrop?.addEventListener("click", () => setMenu(false));
})();
