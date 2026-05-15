#!/usr/bin/env node
//
// Jerry adapter — runs on jerry-app, bound to 127.0.0.1:8910.
// Sits in front of /opt/jerry (real Jerry, on 127.0.0.1:8900) and
// exposes a stable, app-facing contract that Traction calls over
// HTTPS via whatever tunnel/proxy you front this with.
//
// Responsibilities:
//   1. Authenticate the caller via Authorization: Bearer ${ADAPTER_KEY}.
//   2. Accept the rich Traction payload (org, week, board, transcripts).
//   3. Flatten it into the single { question, session_id } payload that
//      real Jerry (POST /v1/jerry/query) understands.
//   4. Call real Jerry on loopback.
//   5. Map Jerry's { answer, citations, tool_calls, hops } into the
//      app-facing { reply, citations, actionIntents?, jerryVersion? }.
//
// No npm dependencies — built on Node's stdlib so the adapter has no
// install step beyond `node server.js`.
//
// Environment variables (set in the systemd unit):
//   ADAPTER_PORT      default 8910
//   ADAPTER_KEY       required — bearer token Traction sends
//   JERRY_URL         default http://127.0.0.1:8900
//   JERRY_TIMEOUT_MS  default 30000

"use strict";

const http = require("node:http");

const PORT = Number(process.env.ADAPTER_PORT || 8910);
const ADAPTER_KEY = process.env.ADAPTER_KEY;
const JERRY_URL = (process.env.JERRY_URL || "http://127.0.0.1:8900").replace(/\/+$/, "");
const JERRY_TIMEOUT_MS = Number(process.env.JERRY_TIMEOUT_MS || 30000);

if (!ADAPTER_KEY) {
  console.error("[jerry-adapter] ADAPTER_KEY is required");
  process.exit(1);
}

function send(res, status, body, headers) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain" : "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...(headers || {}),
  });
  res.end(payload);
}

function readBody(req, max = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > max) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── Payload flattening: rich Traction context → single question string ────

function fmtNum(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

function flatten(req) {
  const lines = [];
  const org = req.org || {};
  const actor = req.actor || {};
  const week = req.week;
  const meeting = req.meeting || {};

  lines.push(`Active org: ${org.orgName || org.orgSlug || "?"} (${org.orgId || "?"})`);
  if (week) {
    lines.push(`Current week ending: ${week.weekEndingDate} (${week.quarter})`);
  } else {
    lines.push(`Current week: not set`);
  }
  if (meeting.nextScheduledFor) {
    lines.push(`Next L10: ${meeting.nextScheduledFor}`);
  }
  lines.push(`Actor: ${actor.name || "?"} (${actor.role || "?"})`);

  if (Array.isArray(req.scorecard) && req.scorecard.length > 0) {
    lines.push("");
    lines.push(`Scorecard (${req.scorecard.length} KPIs):`);
    for (const k of req.scorecard) {
      const goal = k.goalValue !== null ? fmtNum(k.goalValue) : "—";
      const cur = k.currentActual !== null ? fmtNum(k.currentActual) : "MISSING";
      const hist = (k.history || [])
        .map((h) => `${h.weekEndingDate}=${h.actual !== null ? fmtNum(h.actual) : "—"}`)
        .join(" ");
      lines.push(`  - ${k.name} [${k.ownerName || "—"}] ${k.goalDirection} ${goal} | this week: ${cur}${hist ? ` | history: ${hist}` : ""}`);
    }
  }

  if (Array.isArray(req.rocks) && req.rocks.length > 0) {
    lines.push("");
    lines.push(`Rocks (${req.rocks.length}):`);
    for (const r of req.rocks) {
      lines.push(`  - [${r.status}] ${r.description} [${r.ownerName || "—"}] ${r.quarter}${r.notes ? ` — notes: ${r.notes}` : ""}`);
    }
  }

  if (Array.isArray(req.todos) && req.todos.length > 0) {
    lines.push("");
    lines.push(`Open to-dos (${req.todos.length}):`);
    for (const t of req.todos) {
      const due = t.dueDate ? ` due ${t.dueDate}` : "";
      const roll = t.rolloverCount > 0 ? ` rolled ${t.rolloverCount}×` : "";
      lines.push(`  - ${t.description} [${t.ownerName || "—"}]${due}${roll}${t.notes ? ` — ${t.notes}` : ""}`);
    }
  }

  if (Array.isArray(req.issues) && req.issues.length > 0) {
    lines.push("");
    lines.push(`Open issues (${req.issues.length}):`);
    for (const i of req.issues) {
      lines.push(`  - [${i.priority}/${i.status}] ${i.title} [${i.ownerName || "—"}]${i.rootCause ? ` — ${i.rootCause}` : ""}`);
    }
  }

  if (Array.isArray(req.readiness) && req.readiness.length > 0) {
    lines.push("");
    lines.push(`Readiness:`);
    for (const r of req.readiness) {
      const tag = r.obligated ? r.status : "—";
      lines.push(`  - ${r.personName}: ${tag} (${r.label})`);
    }
  }

  if (Array.isArray(req.transcripts) && req.transcripts.length > 0) {
    lines.push("");
    lines.push(`Recent transcript pointers:`);
    for (const t of req.transcripts) {
      lines.push(`  - ${t.transcriptId} ${t.meetingDate || "?"} (${t.source}, ${t.durationSec || "?"}s)`);
    }
  }

  lines.push("");
  lines.push(`User question: ${req.prompt || ""}`);

  return lines.join("\n");
}

// ── Real-Jerry call ────────────────────────────────────────────────────────

function callJerry(question, sessionId) {
  return new Promise((resolve, reject) => {
    const url = new URL(JERRY_URL + "/v1/jerry/query");
    const payload = JSON.stringify(sessionId ? { question, session_id: sessionId } : { question });
    const opts = {
      method: "POST",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const lib = url.protocol === "https:" ? require("node:https") : http;
    const t = setTimeout(() => req.destroy(new Error("jerry timeout")), JERRY_TIMEOUT_MS);
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(t);
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(Object.assign(new Error(`jerry ${res.statusCode}`), { status: res.statusCode, body }));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch { resolve({ answer: body }); }
      });
    });
    req.on("error", (e) => { clearTimeout(t); reject(e); });
    req.write(payload);
    req.end();
  });
}

// ── Map Jerry's response to the app-facing shape ──────────────────────────

function mapJerryResponse(j) {
  if (!j || typeof j !== "object") return { reply: String(j ?? "") };
  return {
    reply: typeof j.answer === "string" ? j.answer : (typeof j.reply === "string" ? j.reply : ""),
    citations: Array.isArray(j.citations) ? j.citations : undefined,
    // tool_calls semantics aren't formally mapped to actionIntents yet —
    // surface them only when they match a known intent kind. Anything
    // else is omitted (the dock already shows reply + citations).
    actionIntents: Array.isArray(j.tool_calls)
      ? j.tool_calls.filter(isActionIntent)
      : Array.isArray(j.actionIntents)
        ? j.actionIntents
        : undefined,
    jerryVersion: typeof j.version === "string" ? j.version : undefined,
  };
}

const INTENT_KINDS = new Set([
  "update_actual",
  "update_rock_status",
  "set_todo_done",
  "update_issue_status",
  "create_todo",
  "create_issue",
]);
function isActionIntent(x) {
  return x && typeof x === "object" && typeof x.kind === "string" && INTENT_KINDS.has(x.kind);
}

// ── HTTP routing ──────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, service: "jerry-adapter" });
  }

  if (req.method !== "POST" || req.url !== "/jerry/query") {
    return send(res, 404, { error: "not found" });
  }

  // Auth — bearer token check.
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${ADAPTER_KEY}`) {
    return send(res, 401, { error: "unauthorized" });
  }

  let bodyText;
  try {
    bodyText = await readBody(req);
  } catch (e) {
    return send(res, 400, { error: e.message || "bad request" });
  }
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return send(res, 400, { error: "invalid json" });
  }
  if (typeof payload?.prompt !== "string" || payload.prompt.trim() === "") {
    return send(res, 400, { error: "prompt required" });
  }

  const question = flatten(payload);
  // session_id keyed on org + actor — gives Jerry continuity per user
  // per active org without leaking history across orgs.
  const sessionId = payload.org?.orgId && payload.actor?.personId
    ? `${payload.org.orgId}:${payload.actor.personId}`
    : undefined;

  let jerry;
  try {
    jerry = await callJerry(question, sessionId);
  } catch (e) {
    console.error("[jerry-adapter] jerry call failed:", e.status || "", e.message);
    return send(res, 502, { error: `jerry upstream error: ${e.message}`, status: e.status, body: e.body?.slice?.(0, 500) });
  }

  return send(res, 200, mapJerryResponse(jerry));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[jerry-adapter] listening on 127.0.0.1:${PORT} → ${JERRY_URL}`);
});
