/**
 * AR Aging (Detailed) doorway parser — the inbound side of the Collections
 * module.
 *
 * Acumatica's "AR Aging (Detailed)" export is a grouped report, not a flat
 * table: a customer header, then invoice/credit/payment line items, then a
 * "Customer Total:" row, repeated per customer, under a report header carrying
 * the company and the "Aged On" date. This function owns that shape.
 *
 * Posture (same discipline as every other doorway):
 * - Deterministic. The caller extracts a 2D grid of cells from the xlsx/CSV;
 *   this function parses structure only. No model guesses at balances, dates,
 *   or customers. Rows it does not recognize are ignored, never invented.
 * - Column positions are resolved from the report's own header row (by label),
 *   not hard-coded, so a re-ordered export still parses.
 * - Pure and dependency-free, so it is unit-testable without a database and
 *   cannot, by construction, send anything.
 */

export type Cell = string | number | null | undefined;

export interface AgingBuckets {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  over90: number;
  balance: number;
}

export interface AgingLine {
  docType: string;
  refNbr: string;
  customerRef: string;
  branch: string;
  docDate: string | null;
  dueDate: string | null;
  buckets: AgingBuckets;
}

export interface AgingCustomer {
  customerId: string;
  customerName: string;
  /**
   * AR contact address, when the Customer entity supplied one. Absent for the
   * CSV path and for customers with no email on file — a chase without an
   * address is still raised for a human, it just can't be auto-drafted.
   */
  email?: string;
  buckets: AgingBuckets;
  lines: AgingLine[];
}

export interface ParsedAging {
  company: string | null;
  agedOn: string | null; // YYYY-MM-DD
  customers: AgingCustomer[];
}

const DOC_TYPES = new Set([
  "Invoice",
  "Credit Memo",
  "Debit Memo",
  "Payment",
  "Prepayment",
  "Overdue Charge",
  "Small Credit W/O",
  "Small Balance W/O",
]);

function s(cell: Cell): string {
  return cell === null || cell === undefined ? "" : String(cell).trim();
}

function n(cell: Cell): number {
  if (typeof cell === "number") return cell;
  const cleaned = s(cell)
    .replace(/[$,]/g, "")
    .replace(/^\((.*)\)$/, "-$1");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Parse CSV text into a raw cell grid (RFC-4180-ish: quoted fields, embedded
 * commas/quotes/newlines). Cells stay as strings — the aging parser's own
 * numeric/date coercion handles Acumatica's CSV formats ("1,234.56", "(20.00)",
 * "6/14/2026"). This is the file-reading front for a CSV aging export; the xlsx
 * path supplies its own grid.
 */
export function parseCsvGrid(text: string): Cell[][] {
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      sawAny = true;
    } else if (c === "\r") {
      // ignore; handled by \n
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAny = false;
    } else {
      field += c;
      sawAny = true;
    }
  }
  if (sawAny || field.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Excel serial date (or a parseable date string) -> YYYY-MM-DD, else null. */
export function toIsoDate(cell: Cell): string | null {
  if (typeof cell === "number" && Number.isFinite(cell)) {
    const utcDays = Math.floor(cell) - 25569; // 25569 = Excel serial for 1970-01-01
    const date = new Date(utcDays * 86400 * 1000);
    return Number.isNaN(date.getTime())
      ? null
      : date.toISOString().slice(0, 10);
  }
  const text = s(cell);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 10);
}

function norm(cell: Cell): string {
  return s(cell).toLowerCase().replace(/\s+/g, " ");
}

interface ColumnMap {
  docType: number;
  refNbr: number;
  customerRef: number;
  branch: number;
  docDate: number;
  dueDate: number;
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  over90: number;
  balance: number;
}

/** Build a column map from a line-item header row (the one containing "Doc. Type"). */
function readColumnMap(row: Cell[]): ColumnMap {
  const find = (pred: (label: string) => boolean, fallback: number): number => {
    const idx = row.findIndex((c) => pred(norm(c)));
    return idx >= 0 ? idx : fallback;
  };
  return {
    docType: find((l) => l.startsWith("doc. type") || l === "doc type", 0),
    refNbr: find((l) => l.startsWith("ref. nbr") || l.startsWith("ref nbr"), 1),
    customerRef: find((l) => l.includes("customer ref"), 2),
    branch: find((l) => l === "branch", 3),
    docDate: find((l) => l.startsWith("doc. date") || l === "doc date", 4),
    dueDate: find((l) => l.startsWith("due date"), 5),
    current: find((l) => l === "current", 6),
    d1_30: find((l) => l.includes("1 - 30") || l.includes("1-30"), 7),
    d31_60: find((l) => l.includes("31 - 60") || l.includes("31-60"), 8),
    d61_90: find((l) => l.includes("61 - 90") || l.includes("61-90"), 9),
    over90: find((l) => l.includes("over 90"), 10),
    balance: find((l) => l === "balance", 11),
  };
}

function readBuckets(row: Cell[], map: ColumnMap): AgingBuckets {
  return {
    current: n(row[map.current]),
    d1_30: n(row[map.d1_30]),
    d31_60: n(row[map.d31_60]),
    d61_90: n(row[map.d61_90]),
    over90: n(row[map.over90]),
    balance: n(row[map.balance]),
  };
}

/** Sum of the four past-due buckets (everything not Current). */
export function pastDue(b: AgingBuckets): number {
  return Math.round((b.d1_30 + b.d31_60 + b.d61_90 + b.over90) * 100) / 100;
}

/** The worst (oldest) bucket a customer has money in. Drives the ladder step. */
export function worstBucket(
  b: AgingBuckets,
): "over90" | "d61_90" | "d31_60" | "d1_30" | "current" {
  if (Math.round(b.over90 * 100) !== 0) return "over90";
  if (Math.round(b.d61_90 * 100) !== 0) return "d61_90";
  if (Math.round(b.d31_60 * 100) !== 0) return "d31_60";
  if (Math.round(b.d1_30 * 100) !== 0) return "d1_30";
  return "current";
}

/**
 * Parse an already-extracted grid of cells from an Acumatica AR Aging
 * (Detailed) export into structured per-customer aging.
 */
export function parseArAgingDetailed(rows: Cell[][]): ParsedAging {
  let company: string | null = null;
  let agedOn: string | null = null;
  const customers: AgingCustomer[] = [];

  let map: ColumnMap | null = null;
  let current: AgingCustomer | null = null;
  let expectCustomerRow = false;
  let customerNameCol = 2;

  for (const row of rows) {
    // Report header fields.
    const companyIdx = row.findIndex((c) =>
      norm(c).startsWith("company/branch"),
    );
    if (companyIdx >= 0 && company === null) {
      company = s(row[companyIdx + 1]) || null;
    }
    const agedIdx = row.findIndex((c) => norm(c).startsWith("aged on"));
    if (agedIdx >= 0 && agedOn === null) {
      agedOn = toIsoDate(row[agedIdx + 1]);
    }

    // Customer header ("Customer" ... "Customer Name") announces the next row.
    const custLabelCol = row.findIndex((c) => norm(c) === "customer");
    const nameLabelCol = row.findIndex((c) => norm(c) === "customer name");
    if (custLabelCol >= 0 && nameLabelCol >= 0) {
      expectCustomerRow = true;
      customerNameCol = nameLabelCol;
      continue;
    }
    if (expectCustomerRow) {
      const id = s(row.find((c) => s(c) !== ""));
      if (id) {
        current = {
          customerId: id,
          customerName: s(row[customerNameCol]),
          buckets: {
            current: 0,
            d1_30: 0,
            d31_60: 0,
            d61_90: 0,
            over90: 0,
            balance: 0,
          },
          lines: [],
        };
        customers.push(current);
      }
      expectCustomerRow = false;
      continue;
    }

    // Line-item column header.
    if (row.some((c) => norm(c).startsWith("doc. type"))) {
      map = readColumnMap(row);
      continue;
    }

    // Customer total closes the current customer.
    if (row.some((c) => norm(c) === "customer total:")) {
      if (current && map) current.buckets = readBuckets(row, map);
      current = null;
      map = null;
      continue;
    }

    // Line item.
    if (current && map) {
      const docType = s(row[map.docType]);
      if (DOC_TYPES.has(docType)) {
        current.lines.push({
          docType,
          refNbr: s(row[map.refNbr]),
          customerRef: s(row[map.customerRef]),
          branch: s(row[map.branch]),
          docDate: toIsoDate(row[map.docDate]),
          dueDate: toIsoDate(row[map.dueDate]),
          buckets: readBuckets(row, map),
        });
      }
    }
  }

  return { company, agedOn, customers };
}
