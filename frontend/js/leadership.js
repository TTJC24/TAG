import { fetchJson, renderRows } from "./api.js";

async function load() {
  const status = document.getElementById("status");
  try {
    const payload = await fetchJson("/api/v1/leadership-flash");
    status.textContent = `Mode: read-only | Items: ${payload.items.length}`;
    renderRows("rows", payload.items);
  } catch (error) {
    status.textContent = `FAIL: ${error.message}`;
  }
}

load();
