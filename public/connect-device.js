const devices = document.querySelector("#connected-devices");

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error || "Request failed"); return payload;
}

async function loadDevices() {
  try {
    const data = await api("/api/mobile/devices"); devices.replaceChildren(); devices.setAttribute("aria-busy", "false");
    if (!data.devices.length) { const empty = document.createElement("p"); empty.className = "device-empty"; empty.textContent = "No iPhones connected yet."; devices.append(empty); return; }
    for (const item of data.devices) {
      const row = document.createElement("div"); row.className = "connected-device"; const icon = document.createElement("span"); icon.textContent = "▯";
      const copy = document.createElement("span"); const name = document.createElement("strong"); name.textContent = item.device_name; const date = document.createElement("small"); date.textContent = `Last synced ${new Date(`${item.last_used_at.replace(" ", "T")}Z`).toLocaleString("en-IN")}`; copy.append(name, date); row.append(icon, copy); devices.append(row);
    }
  } catch { devices.textContent = "Connected devices could not be loaded."; devices.setAttribute("aria-busy", "false"); }
}

loadDevices();
