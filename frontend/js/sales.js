import { fetchJson, renderRows } from "./api.js";

async function load() {
  const status = document.getElementById("status");
  try {
    const payload = await fetchJson("/api/v1/sales-scoreboard");
    status.textContent = `Mode: read-only | Items: ${payload.items.length}`;
    renderRows("rows", payload.items);
  } catch (error) {
    status.textContent = `FAIL: ${error.message}`;
  }
}

load();
