(() => {
  const localDate = (date) => { const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return adjusted.toISOString().slice(0, 10); };
  function range(root) {
    const value = root.querySelector("[data-window-select]").value; if (value === "all") return {};
    if (value === "custom") return { from: root.querySelector("[data-window-from]").value || "", to: root.querySelector("[data-window-to]").value || "" };
    const now = new Date(); let from;
    if (value === "month") from = new Date(now.getFullYear(), now.getMonth(), 1);
    else if (value === "year") from = new Date(now.getFullYear(), 0, 1);
    else { from = new Date(now); from.setDate(from.getDate() - Number(value) + 1); }
    return { from: localDate(from), to: localDate(now) };
  }
  function query(root) { const value = range(root); const params = new URLSearchParams(); if (value.from) params.set("from", value.from); if (value.to) params.set("to", value.to); if (value.from || value.to) params.set("offset", String(-new Date().getTimezoneOffset())); return params; }
  function setup(root, onChange) {
    const select = root.querySelector("[data-window-select]"); const from = root.querySelector("[data-window-from]"); const to = root.querySelector("[data-window-to]");
    const applyPreset = () => { const value = range(root); from.value = value.from || ""; to.value = value.to || ""; onChange?.(value); };
    select.addEventListener("change", applyPreset);
    [from, to].forEach((input) => input.addEventListener("change", () => {
      if (from.value && to.value && from.value > to.value) { if (input === from) to.value = from.value; else from.value = to.value; }
      select.value = "custom"; onChange?.(range(root));
    }));
    applyPreset();
  }
  window.PaisaDateWindow = { setup, query, range };
})();
