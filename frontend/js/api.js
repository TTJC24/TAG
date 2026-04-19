const API_BASE = window.SCOREBOARD_API_BASE || "http://localhost:8000";

export async function fetchJson(path) {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

export function renderRows(targetId, items) {
  const tbody = document.getElementById(targetId);
  tbody.innerHTML = "";
  items.forEach((item) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${item.name}</td>
      <td>${item.value ?? "null"}</td>
      <td>${item.source_system}</td>
      <td>${item.as_of_timestamp ?? "n/a"}</td>
      <td>${item.freshness_state}</td>
      <td>${item.certification_state}</td>
      <td class="fail">${item.fail_state?.state || ""} ${item.fail_state?.reason || ""}</td>
    `;
    tbody.appendChild(row);
  });
}
