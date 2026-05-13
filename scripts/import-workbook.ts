// Workbook importer — replaces placeholder seed values with the
// canonical reference workbook contents.
//
// Source:  reference/TRACTION_MEETING_TEMPLATE.xlsx
// Tabs:    4-27, 5-4, 5-11 (weekly) + Appendix
//
// Run:     pnpm tsx --env-file=.env.local scripts/import-workbook.ts
//
// What this does:
//   1. Adds Craig Zahner to USA org_memberships (per latest decision).
//   2. Defines the canonical measurables per org from the workbook AND
//      the user's USA-split overrides:
//        - USA Open Orders (Backlog)        → REMOVED
//        - USA Revenue (Weekly)             → renamed "USA Domestic Revenue"
//        - USA Gross Profit %               → renamed "USA Domestic GP %"
//        - USA Domestic Pipeline / Quoting  → ADDED (owner: Andrew)
//        - USA International Revenue        → ADDED (owner: Bill)
//        - USA International GP %           → ADDED (owner: Bill)
//        - USA International Pipeline / Quoting → ADDED (owner: Bill)
//   3. WIPES existing entries / rocks / todos / issues (the previous
//      seed values were synthetic), then writes workbook-derived rows.
//   4. WIPES existing weeks and re-creates them aligned to the workbook
//      tab names (4-27, 5-4, 5-11 → 2026-04-27, 2026-05-04, 2026-05-11).
//   5. UPSERTS measurables (preserves IDs so future entries land
//      correctly). Drops measurables not in the canonical set.
//   6. Surfaces ambiguities (unresolved owners, unmapped rows) at the
//      end so they can be triaged.

import * as path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/lib/db/client";
import {
  entries,
  issues,
  measurables,
  orgMemberships,
  organizations,
  people,
  rocks,
  todos,
  weeks,
} from "@/lib/db/schema";

const FILE = path.resolve(
  process.cwd(),
  "reference/TRACTION_MEETING_TEMPLATE.xlsx",
);

const WEEKLY_TABS: { sheet: string; weekEndingDate: string }[] = [
  { sheet: "4-27", weekEndingDate: "2026-04-27" },
  { sheet: "5-4", weekEndingDate: "2026-05-04" },
  { sheet: "5-11", weekEndingDate: "2026-05-11" },
];

type OrgCode = "FS" | "BL" | "USA";
const ALL_ORGS: OrgCode[] = ["FS", "BL", "USA"];

// Owner first-name (UPPER, trimmed) → person slug. "CHRIS" alone is
// ambiguous and gets resolved by entity context in `resolveOwner()`.
const OWNER_TO_SLUG: Record<string, string> = {
  DANIEL: "daniel",
  NICK: "nick",
  ANDREW: "andrew",
  TIM: "tim",
  CRAIG: "craig",
  TOM: "tom",
  CHIP: "chip",
  "CHRIS B": "chris_booth",
  MIKE: "mike",
  BILL: "bill",
  CODY: "cody",
  TYLER: "tyler",
};

// Owner whose primary (default) org is used when an "ALL" rock/todo
// owned by them needs to land in exactly one org.
const PRIMARY_ORG_BY_SLUG: Record<string, OrgCode> = {
  tim: "BL",
  daniel: "FS",
  nick: "BL",
  andrew: "USA",
  craig: "BL",
  tom: "FS",
  chip: "FS",
  chris_booth: "BL",
  chris_coghlan: "FS",
  mike: "USA",
  bill: "USA",
  cody: "BL",
  tyler: "BL",
};

const ambiguities: string[] = [];
function flag(msg: string) {
  ambiguities.push(msg);
  console.warn(`  ⚠  ${msg}`);
}

function normalizeOwnerString(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).trim().toUpperCase();
}

function resolveOwner(rawOwner: unknown, entity: string | null): string | null {
  const norm = normalizeOwnerString(rawOwner);
  if (!norm) return null;
  if (norm === "CHRIS") {
    // CHRIS by entity: Chris Booth (BL) vs Chris Coghlan (FS, USA).
    if (entity === "BL") return "chris_booth";
    if (entity === "FS" || entity === "USA") return "chris_coghlan";
    flag(`CHRIS owner with no entity context — assuming Chris Booth`);
    return "chris_booth";
  }
  return OWNER_TO_SLUG[norm] ?? null;
}

function normalizeEntity(raw: unknown): OrgCode | "ALL" | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toUpperCase();
  if (s === "FS" || s === "BL" || s === "USA") return s as OrgCode;
  if (s === "ALL") return "ALL";
  return null;
}

interface ParsedGoal {
  value: number | null;
  direction: "gte" | "lte" | null;
}

function parseGoal(raw: unknown): ParsedGoal {
  if (raw === null || raw === undefined) return { value: null, direction: null };
  if (typeof raw === "number") return { value: raw, direction: null };
  const s = String(raw).trim();
  if (!s) return { value: null, direction: null };
  if (/per\s+(budget|forecast|week|entity|month)/i.test(s)) return { value: null, direction: null };
  if (/declining/i.test(s)) return { value: null, direction: null };
  const lte = s.includes("≤");
  const gte = s.includes("≥");
  // Take the first numeric run.
  const m = s.match(/[-+]?\d+(?:\.\d+)?/);
  if (!m) return { value: null, direction: null };
  const n = Number(m[0]);
  if (!Number.isFinite(n)) return { value: null, direction: null };
  return { value: n, direction: lte ? "lte" : gte ? "gte" : null };
}

function parseRockStatus(raw: unknown): "on_track" | "off_track" | "completed" {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s.includes("complete")) return "completed";
  if (s.includes("off")) return "off_track";
  return "on_track";
}

function parsePriority(raw: unknown): "critical" | "high" | "medium" | "low" {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s.startsWith("1")) return "critical";
  if (s.startsWith("2")) return "high";
  if (s.startsWith("3")) return "medium";
  if (s.startsWith("4")) return "low";
  if (s.includes("critical")) return "critical";
  if (s.includes("high")) return "high";
  if (s.includes("medium")) return "medium";
  if (s.includes("low")) return "low";
  return "medium";
}

function parseTodoDone(raw: unknown): boolean {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "yes" || s === "y" || s === "done";
}

function parseDate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    const y = raw.getFullYear();
    const m = String(raw.getMonth() + 1).padStart(2, "0");
    const d = String(raw.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}

// ─── Workbook parsing ────────────────────────────────────────────────────

interface SheetRow {
  cells: unknown[];
}

/** Read a sheet as a 2D array, then shift columns left so that the
 *  "KPI" header lands in column 0. The 5-4 tab has an extra leading
 *  blank column compared to 4-27 / 5-11; the KPI header anchor handles
 *  that uniformly. */
function readSheet(wb: XLSX.WorkBook, name: string): SheetRow[] {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  const aoa: unknown[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    raw: true,
    blankrows: false,
  });
  // Find the row that contains the literal "KPI" header and the column
  // it sits in. That column becomes the new column 0.
  let trimCols = 0;
  for (const row of aoa) {
    for (let c = 0; c < row.length; c++) {
      if (typeof row[c] === "string" && (row[c] as string).trim() === "KPI") {
        trimCols = c;
        break;
      }
    }
    if (trimCols > 0) break;
  }
  return aoa.map((r) => ({ cells: r.slice(trimCols) }));
}

function findRowIndex(rows: SheetRow[], pred: (r: SheetRow) => boolean): number {
  for (let i = 0; i < rows.length; i++) if (pred(rows[i]!)) return i;
  return -1;
}

interface WorkbookScorecardRow {
  kpi: string;
  ownerRaw: string;
  entity: OrgCode | "ALL";
  goal: ParsedGoal;
  actual: number | null;
}

interface WorkbookRockRow {
  description: string;
  ownerRaw: string;
  entity: OrgCode | "ALL";
  status: "on_track" | "off_track" | "completed";
  notes: string | null;
}

interface WorkbookTodoRow {
  description: string;
  ownerRaw: string;
  entity: OrgCode | "ALL" | null;
  dueDate: string | null;
  done: boolean;
}

interface WorkbookIssueRow {
  title: string;
  priority: "critical" | "high" | "medium" | "low";
  ownerRaw: string;
  entity: OrgCode | "ALL" | null;
  rootCause: string | null;
}

interface WeeklyParse {
  weekEndingDate: string;
  scorecard: WorkbookScorecardRow[];
  rocks: WorkbookRockRow[];
  todos: WorkbookTodoRow[];
  issues: WorkbookIssueRow[];
}

function parseWeekly(rows: SheetRow[], weekEndingDate: string): WeeklyParse {
  const result: WeeklyParse = {
    weekEndingDate,
    scorecard: [],
    rocks: [],
    todos: [],
    issues: [],
  };

  const cellStr = (v: unknown) => (v === null || v === undefined ? "" : String(v));

  const scorecardHeader = findRowIndex(rows, (r) => /^KPI$/i.test(cellStr(r.cells[0])));
  const rockHeader = findRowIndex(rows, (r) => /^Rock Description$/i.test(cellStr(r.cells[0])));
  const todoHeader = findRowIndex(rows, (r) => /^To-?Do Item$/i.test(cellStr(r.cells[0])));
  const issueHeader = findRowIndex(rows, (r) => /^Issue$/i.test(cellStr(r.cells[0])));
  const concludeRow = findRowIndex(rows, (r) => /^CONCLUDE$/i.test(cellStr(r.cells[0])));

  // SCORECARD: rows between scorecardHeader+1 and rockHeader (exclusive).
  if (scorecardHeader >= 0 && rockHeader > scorecardHeader) {
    for (let i = scorecardHeader + 1; i < rockHeader; i++) {
      const c = rows[i]!.cells;
      const kpi = cellStr(c[0]).trim();
      const ownerRaw = cellStr(c[1]).trim();
      const entityRaw = cellStr(c[2]).trim();
      if (!kpi) continue;
      // Skip section title rows like "ROCK REVIEW — ..." that sometimes
      // sneak in if the regex matches differently.
      if (/^ROCK\b/i.test(kpi)) break;
      const entity = normalizeEntity(entityRaw);
      if (!entity) {
        flag(`[${weekEndingDate}] scorecard row "${kpi}" has unknown entity "${entityRaw}" — skipping`);
        continue;
      }
      const goal = parseGoal(c[3]);
      const actualRaw = c[4];
      const actual = typeof actualRaw === "number" ? actualRaw : null;
      result.scorecard.push({ kpi, ownerRaw, entity, goal, actual });
    }
  }

  // ROCKS: rows between rockHeader+1 and todoHeader.
  if (rockHeader >= 0 && todoHeader > rockHeader) {
    for (let i = rockHeader + 1; i < todoHeader; i++) {
      const c = rows[i]!.cells;
      const description = cellStr(c[0]).trim();
      if (!description) continue;
      if (/^TO-?DO\b/i.test(description)) break;
      const ownerRaw = cellStr(c[1]).trim();
      const entityRaw = cellStr(c[2]).trim();
      const entity = normalizeEntity(entityRaw);
      if (!entity) {
        flag(`[${weekEndingDate}] rock "${description}" has unknown entity "${entityRaw}" — skipping`);
        continue;
      }
      const status = parseRockStatus(c[4]);
      const notes = cellStr(c[5]).trim() || null;
      result.rocks.push({ description, ownerRaw, entity, status, notes });
    }
  }

  // TODOS: rows between todoHeader+1 and issueHeader.
  if (todoHeader >= 0 && issueHeader > todoHeader) {
    for (let i = todoHeader + 1; i < issueHeader; i++) {
      const c = rows[i]!.cells;
      const description = cellStr(c[0]).trim();
      if (!description) continue;
      if (/^IDS\b/i.test(description)) break;
      const ownerRaw = cellStr(c[1]).trim();
      const entityRaw = cellStr(c[2]).trim();
      const entity = entityRaw ? normalizeEntity(entityRaw) : null;
      const dueDate = parseDate(c[3]);
      const done = parseTodoDone(c[4]);
      result.todos.push({ description, ownerRaw, entity, dueDate, done });
    }
  }

  // ISSUES: rows between issueHeader+1 and concludeRow.
  if (issueHeader >= 0 && concludeRow > issueHeader) {
    for (let i = issueHeader + 1; i < concludeRow; i++) {
      const c = rows[i]!.cells;
      const title = cellStr(c[0]).trim();
      if (!title) continue;
      if (/^CONCLUDE$/i.test(title)) break;
      const priority = parsePriority(c[1]);
      const ownerRaw = cellStr(c[2]).trim();
      const entityRaw = cellStr(c[3]).trim();
      const entity = entityRaw ? normalizeEntity(entityRaw) : null;
      const rootCause = cellStr(c[4]).trim() || null;
      result.issues.push({ title, priority, ownerRaw, entity, rootCause });
    }
  }

  return result;
}

// ─── DB helpers ──────────────────────────────────────────────────────────

interface PersonLite {
  id: string;
  name: string;
  email: string;
}
const personBySlug = new Map<string, PersonLite>();
const orgIdByCode = new Map<OrgCode, string>();

async function loadPeopleAndOrgs() {
  const orgs = await db.select().from(organizations);
  for (const o of orgs) {
    if (o.code === "FS" || o.code === "BL" || o.code === "USA") {
      orgIdByCode.set(o.code as OrgCode, o.id);
    }
  }
  // Map person.email → slug via the seed-known canonical emails.
  const EMAIL_TO_SLUG: Record<string, string> = {
    "tclark@bigleaguecs.com": "tim",
    "nicholas.dorfmueller@bigleaguecs.com": "nick",
    "cody.braden@bigleaguecs.com": "cody",
    "tyler.shinn@bigleaguecs.com": "tyler",
    "chris.booth@bigleaguecs.com": "chris_booth",
    "c.bridges@fasteningspecialists.com": "chip",
    "craig.zahner@bigleaguecs.com": "craig",
    "chris.coghlan@bigleaguecs.com": "chris_coghlan",
    "t.fowler@fasteningspecialists.com": "tom",
    "d.milavickas@fasteningspecialists.com": "daniel",
    "m.grant@fasteningspecialists.com": "mike",
    "andrew@utilitysupplyassociates.com": "andrew",
    "bill@utilitysupplyassociates.com": "bill",
  };
  const ppl = await db.select().from(people);
  for (const p of ppl) {
    const slug = EMAIL_TO_SLUG[p.email.toLowerCase()];
    if (slug) personBySlug.set(slug, { id: p.id, name: p.name, email: p.email });
  }
}

function personIdForSlug(slug: string | null): string | null {
  if (!slug) return null;
  return personBySlug.get(slug)?.id ?? null;
}

// ─── Canonical measurable definitions ────────────────────────────────────

interface CanonicalMeasurable {
  org: OrgCode;
  name: string;
  ownerSlug: string;
  unit: string;
  formatHint: string;
  goalDirection: "gte" | "lte" | "trend_down" | "between" | "eq" | "trend_up";
  goalValue: number | null;
  cadence: "weekly" | "monthly";
  formula?: string;
  /** Workbook KPI name + entity that maps to this canonical measurable
   *  (for entry import). When undefined, no workbook entries are
   *  imported (Bill's new metrics, the new Pipeline metrics). */
  fromWorkbook?: { kpi: RegExp; entity: OrgCode | "ALL" };
}

// Regex helpers for fuzzy KPI matching.
const RE = {
  revenue: /^revenue\s*\(weekly\)$/i,
  gp: /^gross profit %$/i,
  dso: /^DSO/i,
  dpo: /^DPO/i,
  dio: /^DIO/i,
  invTurns: /^inventory turns$/i,
  fillRate: /^fill rate %$/i,
  arColl: /^AR Collections/i,
  openOrders: /^open orders/i,
  newAccts: /^new accounts opened$/i,
  onTime: /^on[-\s]*time deliveries\s*$/i,
};

const CANONICAL_MEASURABLES: CanonicalMeasurable[] = [
  // ── FS ──────────────────────────────────────────────────────────────
  { org: "FS", name: "Revenue (Weekly)", ownerSlug: "daniel", unit: "USD", formatHint: "currency_usd", goalDirection: "gte", goalValue: 250_000, cadence: "weekly", formula: "Net sales per entity per week", fromWorkbook: { kpi: RE.revenue, entity: "FS" } },
  { org: "FS", name: "Gross Profit %", ownerSlug: "daniel", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.5, cadence: "weekly", formula: "(Revenue – (COGS + Freight Burden)) / Revenue", fromWorkbook: { kpi: RE.gp, entity: "FS" } },
  { org: "FS", name: "DSO", ownerSlug: "tim", unit: "days", formatHint: "days", goalDirection: "lte", goalValue: 45, cadence: "weekly", formula: "AR / (Revenue / 365)", fromWorkbook: { kpi: RE.dso, entity: "ALL" } },
  { org: "FS", name: "DPO", ownerSlug: "tim", unit: "days", formatHint: "days", goalDirection: "gte", goalValue: 30, cadence: "weekly", formula: "AP / (COGS / 365)", fromWorkbook: { kpi: RE.dpo, entity: "ALL" } },
  { org: "FS", name: "DIO", ownerSlug: "craig", unit: "days", formatHint: "days", goalDirection: "lte", goalValue: 60, cadence: "weekly", formula: "Inventory / (COGS / 365)", fromWorkbook: { kpi: RE.dio, entity: "ALL" } },
  { org: "FS", name: "Inventory Turns", ownerSlug: "craig", unit: "x", formatHint: "turns", goalDirection: "gte", goalValue: 6, cadence: "monthly", formula: "COGS / Avg Inventory", fromWorkbook: { kpi: RE.invTurns, entity: "ALL" } },
  { org: "FS", name: "Fill Rate %", ownerSlug: "tom", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.95, cadence: "weekly", formula: "Lines Shipped Complete / Total Lines Ordered", fromWorkbook: { kpi: RE.fillRate, entity: "FS" } },
  { org: "FS", name: "AR Collections ($)", ownerSlug: "tim", unit: "USD", formatHint: "currency_usd", goalDirection: "gte", goalValue: 250_000, cadence: "weekly", formula: "Cash collected on AR for the week", fromWorkbook: { kpi: RE.arColl, entity: "ALL" } },
  { org: "FS", name: "Open Orders (Backlog)", ownerSlug: "chip", unit: "USD", formatHint: "currency_usd_trend", goalDirection: "trend_down", goalValue: null, cadence: "weekly", formula: "Total open SO value (declining trend)", fromWorkbook: { kpi: RE.openOrders, entity: "ALL" } },
  { org: "FS", name: "New Accounts Opened", ownerSlug: "daniel", unit: "count", formatHint: "count", goalDirection: "gte", goalValue: 1, cadence: "weekly", formula: "New customer accounts opened this week", fromWorkbook: { kpi: RE.newAccts, entity: "FS" } },
  { org: "FS", name: "On-Time Deliveries", ownerSlug: "chip", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.85, cadence: "weekly", formula: "Deliveries on or before promise date", fromWorkbook: { kpi: RE.onTime, entity: "FS" } },

  // ── BL ──────────────────────────────────────────────────────────────
  { org: "BL", name: "Revenue (Weekly)", ownerSlug: "nick", unit: "USD", formatHint: "currency_usd", goalDirection: "gte", goalValue: 100_000, cadence: "weekly", fromWorkbook: { kpi: RE.revenue, entity: "BL" } },
  { org: "BL", name: "Gross Profit %", ownerSlug: "nick", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.3, cadence: "weekly", fromWorkbook: { kpi: RE.gp, entity: "BL" } },
  { org: "BL", name: "DSO", ownerSlug: "tim", unit: "days", formatHint: "days", goalDirection: "lte", goalValue: 45, cadence: "weekly", fromWorkbook: { kpi: RE.dso, entity: "ALL" } },
  { org: "BL", name: "DPO", ownerSlug: "tim", unit: "days", formatHint: "days", goalDirection: "gte", goalValue: 30, cadence: "weekly", fromWorkbook: { kpi: RE.dpo, entity: "ALL" } },
  { org: "BL", name: "DIO", ownerSlug: "craig", unit: "days", formatHint: "days", goalDirection: "lte", goalValue: 60, cadence: "weekly", fromWorkbook: { kpi: RE.dio, entity: "ALL" } },
  { org: "BL", name: "Inventory Turns", ownerSlug: "craig", unit: "x", formatHint: "turns", goalDirection: "gte", goalValue: 6, cadence: "monthly", fromWorkbook: { kpi: RE.invTurns, entity: "ALL" } },
  { org: "BL", name: "Fill Rate %", ownerSlug: "chris_booth", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.95, cadence: "weekly", fromWorkbook: { kpi: RE.fillRate, entity: "BL" } },
  { org: "BL", name: "AR Collections ($)", ownerSlug: "tim", unit: "USD", formatHint: "currency_usd", goalDirection: "gte", goalValue: 250_000, cadence: "weekly", fromWorkbook: { kpi: RE.arColl, entity: "ALL" } },
  { org: "BL", name: "Open Orders (Backlog)", ownerSlug: "chip", unit: "USD", formatHint: "currency_usd_trend", goalDirection: "trend_down", goalValue: null, cadence: "weekly", fromWorkbook: { kpi: RE.openOrders, entity: "ALL" } },
  { org: "BL", name: "New Accounts Opened", ownerSlug: "nick", unit: "count", formatHint: "count", goalDirection: "gte", goalValue: 1, cadence: "weekly", fromWorkbook: { kpi: RE.newAccts, entity: "BL" } },
  { org: "BL", name: "On-Time Deliveries", ownerSlug: "chip", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.85, cadence: "weekly", fromWorkbook: { kpi: RE.onTime, entity: "BL" } },

  // ── USA (split per latest decision) ──────────────────────────────────
  // Andrew's domestic split — workbook's "Revenue (Weekly) USA / ANDREW"
  // and "Gross Profit % USA / ANDREW" map here.
  { org: "USA", name: "USA Domestic Revenue", ownerSlug: "andrew", unit: "USD", formatHint: "currency_usd", goalDirection: "gte", goalValue: 312_000, cadence: "weekly", formula: "Domestic net sales per week", fromWorkbook: { kpi: RE.revenue, entity: "USA" } },
  { org: "USA", name: "USA Domestic GP %", ownerSlug: "andrew", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.15, cadence: "weekly", formula: "Domestic (Revenue – COGS) / Revenue", fromWorkbook: { kpi: RE.gp, entity: "USA" } },
  // No workbook actuals for these — Andrew + Bill enter going forward.
  { org: "USA", name: "USA Domestic Pipeline / Quoting", ownerSlug: "andrew", unit: "USD", formatHint: "currency_usd_trend", goalDirection: "trend_up", goalValue: null, cadence: "weekly", formula: "Open domestic quotes / pipeline value" },
  { org: "USA", name: "USA International Revenue", ownerSlug: "bill", unit: "USD", formatHint: "currency_usd", goalDirection: "gte", goalValue: null, cadence: "weekly", formula: "International net sales per week" },
  { org: "USA", name: "USA International GP %", ownerSlug: "bill", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: null, cadence: "weekly", formula: "International (Revenue – COGS) / Revenue" },
  { org: "USA", name: "USA International Pipeline / Quoting", ownerSlug: "bill", unit: "USD", formatHint: "currency_usd_trend", goalDirection: "trend_up", goalValue: null, cadence: "weekly", formula: "Open international quotes / pipeline value" },
  // Cross-org finance metrics (replicated per org from workbook ALL rows).
  { org: "USA", name: "DSO", ownerSlug: "tim", unit: "days", formatHint: "days", goalDirection: "lte", goalValue: 45, cadence: "weekly", fromWorkbook: { kpi: RE.dso, entity: "ALL" } },
  { org: "USA", name: "DPO", ownerSlug: "tim", unit: "days", formatHint: "days", goalDirection: "gte", goalValue: 30, cadence: "weekly", fromWorkbook: { kpi: RE.dpo, entity: "ALL" } },
  { org: "USA", name: "DIO", ownerSlug: "craig", unit: "days", formatHint: "days", goalDirection: "lte", goalValue: 60, cadence: "weekly", fromWorkbook: { kpi: RE.dio, entity: "ALL" } },
  { org: "USA", name: "Inventory Turns", ownerSlug: "craig", unit: "x", formatHint: "turns", goalDirection: "gte", goalValue: 6, cadence: "monthly", fromWorkbook: { kpi: RE.invTurns, entity: "ALL" } },
  { org: "USA", name: "AR Collections ($)", ownerSlug: "tim", unit: "USD", formatHint: "currency_usd", goalDirection: "gte", goalValue: 250_000, cadence: "weekly", fromWorkbook: { kpi: RE.arColl, entity: "ALL" } },
  // NOTE: USA "Open Orders (Backlog)" is intentionally omitted per the
  // user's decision.
];

// ─── Main import ─────────────────────────────────────────────────────────

async function main() {
  await loadPeopleAndOrgs();
  if (orgIdByCode.size !== 3) {
    throw new Error(`Expected 3 organizations; loaded ${orgIdByCode.size}`);
  }
  console.log(`[import] orgs: ${[...orgIdByCode.keys()].join(", ")}`);
  console.log(`[import] people loaded: ${personBySlug.size}`);
  for (const slug of Object.keys(PRIMARY_ORG_BY_SLUG)) {
    if (!personBySlug.has(slug)) flag(`Person slug "${slug}" not found in DB — re-run pnpm seed first?`);
  }
  if (ambiguities.length > 0) {
    throw new Error("Cannot proceed: missing canonical people. Re-run pnpm seed.");
  }

  const wb = XLSX.readFile(FILE, { cellDates: true });

  // ─── 1) Add Craig Zahner to USA org_memberships ────────────────────
  const usaOrgId = orgIdByCode.get("USA")!;
  const craigId = personBySlug.get("craig")!.id;
  const existingCraigUSA = await db
    .select()
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, usaOrgId), eq(orgMemberships.personId, craigId)))
    .limit(1);
  if (existingCraigUSA[0]) {
    console.log(`[import] Craig Zahner is already in USA org_memberships`);
  } else {
    await db.insert(orgMemberships).values({
      orgId: usaOrgId,
      personId: craigId,
      role: "member",
    });
    console.log(`[import] added Craig Zahner to USA org_memberships`);
  }

  // ─── 2) Parse all weekly tabs ──────────────────────────────────────
  const parsed: WeeklyParse[] = [];
  for (const tab of WEEKLY_TABS) {
    const rows = readSheet(wb, tab.sheet);
    parsed.push(parseWeekly(rows, tab.weekEndingDate));
  }
  for (const w of parsed) {
    console.log(
      `[import] parsed ${w.weekEndingDate}: ${w.scorecard.length} scorecard, ${w.rocks.length} rocks, ${w.todos.length} todos, ${w.issues.length} issues`,
    );
  }

  // ─── 3) Wipe + recreate weeks aligned to workbook ──────────────────
  // Delete entries first (FK), then weeks. We'll recreate from WEEKLY_TABS.
  await db.delete(entries);
  await db.delete(weeks);
  const weekIdByDate = new Map<string, string>();
  for (const tab of WEEKLY_TABS) {
    const d = new Date(tab.weekEndingDate + "T00:00:00Z");
    const isoWeekNumber = isoWeek(d);
    const inserted = await db
      .insert(weeks)
      .values({
        weekEndingDate: tab.weekEndingDate,
        weekNumber: isoWeekNumber,
        quarter: "Q2 2026",
        fiscalYear: 2026,
      })
      .returning({ id: weeks.id });
    weekIdByDate.set(tab.weekEndingDate, inserted[0]!.id);
  }
  console.log(`[import] wrote ${weekIdByDate.size} weeks`);

  // ─── 4) Upsert canonical measurables; drop measurables not in set ──
  const measurableIdByKey = new Map<string, string>(); // `${org}::${name}` → id
  for (const m of CANONICAL_MEASURABLES) {
    const orgId = orgIdByCode.get(m.org)!;
    const ownerId = personIdForSlug(m.ownerSlug);
    if (!ownerId) {
      flag(`measurable "${m.org}::${m.name}" owner slug "${m.ownerSlug}" not resolvable`);
      continue;
    }
    const existing = await db
      .select()
      .from(measurables)
      .where(and(eq(measurables.orgId, orgId), eq(measurables.name, m.name)))
      .limit(1);
    if (existing[0]) {
      // Update in place — keeps id stable so future entries land correctly.
      await db
        .update(measurables)
        .set({
          ownerId,
          unit: m.unit,
          formatHint: m.formatHint,
          goalDirection: m.goalDirection,
          goalValue: m.goalValue !== null ? String(m.goalValue) : null,
          cadence: m.cadence,
          formula: m.formula ?? null,
        })
        .where(eq(measurables.id, existing[0].id));
      measurableIdByKey.set(`${m.org}::${m.name}`, existing[0].id);
    } else {
      const inserted = await db
        .insert(measurables)
        .values({
          orgId,
          name: m.name,
          ownerId,
          unit: m.unit,
          formatHint: m.formatHint,
          goalDirection: m.goalDirection,
          goalValue: m.goalValue !== null ? String(m.goalValue) : null,
          cadence: m.cadence,
          formula: m.formula ?? null,
        })
        .returning({ id: measurables.id });
      measurableIdByKey.set(`${m.org}::${m.name}`, inserted[0]!.id);
    }
  }
  console.log(`[import] upserted ${measurableIdByKey.size} canonical measurables`);

  // Delete measurables that are not in the canonical set.
  // We have to delete dependent entries first (already wiped above).
  const allCurrentMeasurables = await db.select({ id: measurables.id, orgId: measurables.orgId, name: measurables.name }).from(measurables);
  const orgIdToCode = new Map<string, OrgCode>();
  for (const [code, id] of orgIdByCode) orgIdToCode.set(id, code);
  let droppedMeasurables = 0;
  for (const row of allCurrentMeasurables) {
    const code = orgIdToCode.get(row.orgId);
    if (!code) continue;
    const key = `${code}::${row.name}`;
    if (!measurableIdByKey.has(key)) {
      await db.delete(measurables).where(eq(measurables.id, row.id));
      console.log(`  - dropped measurable: ${code} :: ${row.name}`);
      droppedMeasurables++;
    }
  }
  console.log(`[import] dropped ${droppedMeasurables} measurables not in canonical set`);

  // ─── 5) Insert entries from workbook scorecards ────────────────────
  // Percent normalization rule (single source of normalization, per the
  // user's "choose one place" directive):
  //   - All percent-format measurables store entries as decimal fractions
  //     (0..1) so that the formatter's Intl percent style — which
  //     multiplies by 100 — renders correctly.
  //   - The workbook is inconsistent: most rows store whole percents
  //     (59.68 = 59.68%), a few store decimals (0.187 = 18.7%).
  //   - Heuristic: if formatHint==="percent" and value > 1, divide by 100.
  //     Values already in 0..1 are passed through. KPIs in this scorecard
  //     are bounded 0..100% so the heuristic is safe.
  let entriesInserted = 0;
  let percentNormalized = 0;
  for (const week of parsed) {
    const weekId = weekIdByDate.get(week.weekEndingDate);
    if (!weekId) continue;
    for (const sc of week.scorecard) {
      for (const cm of CANONICAL_MEASURABLES) {
        if (!cm.fromWorkbook) continue;
        if (!cm.fromWorkbook.kpi.test(sc.kpi)) continue;
        if (cm.fromWorkbook.entity !== sc.entity) continue;
        const measurableId = measurableIdByKey.get(`${cm.org}::${cm.name}`);
        if (!measurableId) continue;
        if (sc.actual === null) continue;
        let actualToStore = sc.actual;
        if (cm.formatHint === "percent" && actualToStore > 1) {
          actualToStore = actualToStore / 100;
          percentNormalized++;
        }
        await db.insert(entries).values({
          measurableId,
          weekId,
          actual: String(actualToStore),
          source: "system",
        });
        entriesInserted++;
      }
    }
  }
  console.log(
    `[import] inserted ${entriesInserted} entries from workbook (${percentNormalized} percent values normalized)`,
  );

  // ─── 6) Wipe + insert rocks from workbook (latest week wins) ───────
  await db.delete(rocks);
  // Build canonical rocks: dedupe by (description normalized + ownerSlug + entity)
  // taking the LAST occurrence across weeks (latest status / notes).
  const rockMap = new Map<string, { description: string; ownerSlug: string; org: OrgCode; status: "on_track" | "off_track" | "completed"; notes: string | null }>();
  for (const week of parsed) {
    for (const r of week.rocks) {
      const ownerSlug = resolveOwner(r.ownerRaw, r.entity);
      if (!ownerSlug) {
        flag(`rock "${r.description}" has unresolvable owner "${r.ownerRaw}" — skipping`);
        continue;
      }
      // Skip the empty placeholder rows in the workbook.
      if (!r.description.trim()) continue;
      // Determine landing org. ALL → owner's primary org.
      let org: OrgCode;
      if (r.entity === "ALL") {
        org = PRIMARY_ORG_BY_SLUG[ownerSlug] ?? "BL";
      } else {
        org = r.entity;
      }
      const key = `${org}::${r.description.toLowerCase().trim()}::${ownerSlug}`;
      rockMap.set(key, { description: r.description.trim(), ownerSlug, org, status: r.status, notes: r.notes });
    }
  }
  let rocksInserted = 0;
  for (const r of rockMap.values()) {
    const orgId = orgIdByCode.get(r.org)!;
    const ownerId = personIdForSlug(r.ownerSlug);
    if (!ownerId) {
      flag(`rock "${r.description}" owner slug ${r.ownerSlug} not resolvable`);
      continue;
    }
    await db.insert(rocks).values({
      orgId,
      description: r.description,
      ownerId,
      quarter: "Q2 2026",
      dueDate: "2026-06-30",
      status: r.status,
      notes: r.notes,
    });
    rocksInserted++;
  }
  console.log(`[import] inserted ${rocksInserted} rocks`);

  // ─── 7) Wipe + insert todos from workbook (last occurrence wins) ───
  await db.delete(todos);
  const todoMap = new Map<string, { description: string; ownerSlug: string; org: OrgCode; dueDate: string | null; done: boolean }>();
  for (const week of parsed) {
    for (const t of week.todos) {
      if (!t.description.trim()) continue;
      const ownerSlug = resolveOwner(t.ownerRaw, t.entity ?? null);
      if (!ownerSlug) {
        flag(`todo "${t.description}" has unresolvable owner "${t.ownerRaw}" — skipping`);
        continue;
      }
      let org: OrgCode;
      if (t.entity === "ALL" || t.entity === null) {
        org = PRIMARY_ORG_BY_SLUG[ownerSlug] ?? "BL";
      } else {
        org = t.entity;
      }
      const key = `${org}::${t.description.toLowerCase().trim()}::${ownerSlug}`;
      todoMap.set(key, { description: t.description.trim(), ownerSlug, org, dueDate: t.dueDate, done: t.done });
    }
  }
  let todosInserted = 0;
  for (const t of todoMap.values()) {
    const orgId = orgIdByCode.get(t.org)!;
    const ownerId = personIdForSlug(t.ownerSlug);
    if (!ownerId) {
      flag(`todo "${t.description}" owner slug ${t.ownerSlug} not resolvable`);
      continue;
    }
    await db.insert(todos).values({
      orgId,
      description: t.description,
      ownerId,
      dueDate: t.dueDate,
      status: t.done ? "done" : "open",
    });
    todosInserted++;
  }
  console.log(`[import] inserted ${todosInserted} todos`);

  // ─── 8) Wipe + insert issues from workbook ──────────────────────────
  // Two-pass to avoid the "earlier week says blank, later week says TIm,
  // but the report still shows blank" bug. First pass collects every
  // ownerRaw seen across all weeks for each unique title; second pass
  // resolves owner from those candidates, then from an explicit
  // override table, then defaults to Tim and surfaces only the
  // truly-unresolved titles.
  await db.delete(issues);

  /** Explicit owner overrides for issues whose workbook Owner column is
   *  consistently blank across all three weeks. Per the latest user
   *  decision: map the obvious ones deterministically. */
  const ISSUE_OWNER_OVERRIDES: { match: RegExp; ownerSlug: string; org: OrgCode }[] = [
    { match: /^need to know when special orders are received/i, ownerSlug: "chip", org: "FS" },
    { match: /^how do we reduce cycle time on receiving/i, ownerSlug: "chip", org: "BL" },
    { match: /^dead stock report cadence/i, ownerSlug: "craig", org: "FS" },
    { match: /^premature invoices/i, ownerSlug: "tim", org: "BL" },
  ];

  interface IssueDedupe {
    title: string;
    priority: "critical" | "high" | "medium" | "low";
    /** Every non-empty owner string seen across weeks. */
    ownerRaws: string[];
    /** Last seen entity from the workbook (null if never specified). */
    entityFromWorkbook: OrgCode | "ALL" | null;
    rootCause: string | null;
  }
  const issueMap = new Map<string, IssueDedupe>(); // key = title.toLowerCase().trim()

  for (const week of parsed) {
    for (const i of week.issues) {
      const t = i.title.trim();
      if (!t || t.length < 5) continue;
      if (/^issue dumping ground$/i.test(t)) continue;
      if (/^update rocks\s*\?\s*$/i.test(t)) continue;

      const key = t.toLowerCase();
      const existing = issueMap.get(key);
      const ownerRawTrimmed = i.ownerRaw.trim();
      if (existing) {
        if (ownerRawTrimmed) existing.ownerRaws.push(ownerRawTrimmed);
        if (i.entity) existing.entityFromWorkbook = i.entity;
        if (i.rootCause) existing.rootCause = i.rootCause;
        existing.priority = i.priority;
      } else {
        issueMap.set(key, {
          title: t,
          priority: i.priority,
          ownerRaws: ownerRawTrimmed ? [ownerRawTrimmed] : [],
          entityFromWorkbook: i.entity,
          rootCause: i.rootCause,
        });
      }
    }
  }

  const unresolvedIssueOwners: string[] = [];
  let issuesInserted = 0;
  for (const e of issueMap.values()) {
    // 1. Resolve owner from any non-empty raw owner seen across weeks.
    let ownerSlug: string | null = null;
    const entityForChris =
      e.entityFromWorkbook && e.entityFromWorkbook !== "ALL"
        ? e.entityFromWorkbook
        : null;
    for (const raw of e.ownerRaws) {
      const slug = resolveOwner(raw, entityForChris);
      if (slug) {
        ownerSlug = slug;
        break;
      }
    }

    // 2. Apply explicit override (also fixes the landing org).
    const override = ISSUE_OWNER_OVERRIDES.find((o) => o.match.test(e.title));

    let org: OrgCode;
    if (override) {
      ownerSlug = ownerSlug ?? override.ownerSlug;
      org = override.org;
    } else if (e.entityFromWorkbook === "ALL" || e.entityFromWorkbook === null) {
      org = PRIMARY_ORG_BY_SLUG[ownerSlug ?? "tim"] ?? "BL";
    } else {
      org = e.entityFromWorkbook;
    }

    // 3. If still no owner, default to Tim AND surface as unresolved.
    let trulyUnresolved = false;
    if (!ownerSlug) {
      ownerSlug = "tim";
      trulyUnresolved = true;
      unresolvedIssueOwners.push(e.title);
    }

    const orgId = orgIdByCode.get(org)!;
    const ownerId = personIdForSlug(ownerSlug);
    if (!ownerId) {
      flag(`issue "${e.title}" owner slug "${ownerSlug}" not resolvable`);
      continue;
    }
    await db.insert(issues).values({
      orgId,
      title: e.title,
      priority: e.priority,
      ownerId,
      rootCause: e.rootCause,
      status: "open",
    });
    issuesInserted++;
    if (trulyUnresolved) {
      // intentional: counts toward the inserted total but flagged below
    }
  }
  console.log(`[import] inserted ${issuesInserted} issues`);

  // ─── Final report ──────────────────────────────────────────────────
  console.log("");
  console.log(`[import] DONE`);
  console.log(`  weeks imported:          ${weekIdByDate.size}  (${[...weekIdByDate.keys()].join(", ")})`);
  console.log(`  metrics (measurables):   ${measurableIdByKey.size}  canonical, ${droppedMeasurables} dropped`);
  console.log(`  entries from workbook:   ${entriesInserted}`);
  console.log(`  rocks:                   ${rocksInserted}`);
  console.log(`  todos:                   ${todosInserted}`);
  console.log(`  issues:                  ${issuesInserted}`);

  if (unresolvedIssueOwners.length > 0) {
    console.log("");
    console.log(
      `[import] UNRESOLVED issue owners (${unresolvedIssueOwners.length}) — defaulted to Tim, please assign:`,
    );
    for (const t of unresolvedIssueOwners) console.log(`  - ${t}`);
  } else {
    console.log("");
    console.log(`[import] all issue owners resolved`);
  }

  // Other ambiguities (unresolvable rock/todo owners, parse warnings).
  // Kept separate from the issue-owner report above.
  if (ambiguities.length > 0) {
    console.log("");
    console.log(`[import] other warnings (${ambiguities.length}):`);
    for (const a of ambiguities) console.log(`  - ${a}`);
  }
}

function isoWeek(d: Date): number {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  return (
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    )
  );
}

// Quiet unused-import lints during transitional development.
void inArray;

main().catch((err) => {
  console.error("[import] failed:", err);
  process.exit(1);
});
