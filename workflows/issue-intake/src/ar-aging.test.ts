import { describe, expect, it } from "vitest";
import {
  parseArAgingDetailed,
  parseCsvGrid,
  pastDue,
  worstBucket,
  toIsoDate,
  type Cell,
} from "./ar-aging.js";

// Mirrors the real Acumatica "AR Aging (Detailed)" export shape (grouped:
// report header -> customer header -> line items -> Customer Total:), including
// a credit memo that nets against the balance and Excel serial dates. 46209 is
// the serial for 2026-07-06 (the real file was AR_Aging_20260706).
const grid: Cell[][] = [
  ["AR Aging (Detailed)"],
  ["Company/Branch:", "FS", "", "", "", "", "", "", "", "", "Date:", 46209.55],
  ["", "", "", "", "Aged On:", 46209],
  [],
  ["Customer", "", "Customer Name"],
  ["ACME001", "", "Acme Corp"],
  [
    "Doc. Type", "Ref. Nbr.", "Customer Ref.", "Branch", "Doc. Date", "Due Date",
    "Current", "1 - 30 Days", "31 - 60 Days", "61 - 90 Days", "Over 90 Days", "Balance",
  ],
  ["Invoice", "INV1", "ref1", "FS", 46168, 46198, 0, 100, 0, 0, 0, 100],
  ["Invoice", "INV2", "ref2", "FS", 46100, 46130, 0, 0, 50, 0, 0, 50],
  ["Credit Memo", "CM1", "ref3", "FS", 46150, 46150, 0, -20, 0, 0, 0, -20],
  ["", "", "", "", "Customer Total:", "", 0, 80, 50, 0, 0, 130],
  [],
  ["Customer", "", "Customer Name"],
  ["BETA002", "", "Beta LLC"],
  [
    "Doc. Type", "Ref. Nbr.", "Customer Ref.", "Branch", "Doc. Date", "Due Date",
    "Current", "1 - 30 Days", "31 - 60 Days", "61 - 90 Days", "Over 90 Days", "Balance",
  ],
  ["Invoice", "INV3", "ref4", "FS", 46200, 46209, 500, 0, 0, 0, 0, 500],
  ["", "", "", "", "Customer Total:", "", 500, 0, 0, 0, 0, 500],
];

describe("AR aging (detailed) parser", () => {
  const parsed = parseArAgingDetailed(grid);

  it("reads report header: company and aged-on date", () => {
    expect(parsed.company).toBe("FS");
    expect(parsed.agedOn).toBe("2026-07-06");
  });

  it("groups line items under the right customer, with totals", () => {
    expect(parsed.customers).toHaveLength(2);
    const acme = parsed.customers[0]!;
    expect(acme.customerId).toBe("ACME001");
    expect(acme.customerName).toBe("Acme Corp");
    expect(acme.lines).toHaveLength(3); // invoice, invoice, credit memo
    expect(acme.buckets.balance).toBe(130);
    expect(acme.buckets.d1_30).toBe(80);
    expect(acme.buckets.d31_60).toBe(50);
  });

  it("keeps credit memos as negative line items (netting is real)", () => {
    const acme = parsed.customers[0]!;
    const cm = acme.lines.find((l) => l.docType === "Credit Memo");
    expect(cm).toBeDefined();
    expect(cm!.buckets.balance).toBe(-20);
    expect(acme.lines[0]!.dueDate).toBe(toIsoDate(46198));
  });

  it("computes past-due total and the worst bucket for the ladder", () => {
    const acme = parsed.customers[0]!;
    expect(pastDue(acme.buckets)).toBe(130); // all of Acme is past due
    expect(worstBucket(acme.buckets)).toBe("d31_60"); // oldest money is 31-60

    const beta = parsed.customers[1]!;
    expect(pastDue(beta.buckets)).toBe(0); // Beta is entirely current
    expect(worstBucket(beta.buckets)).toBe("current");
  });

  it("does not invent customers from malformed input", () => {
    expect(parseArAgingDetailed([["garbage"], ["nothing", "here"]]).customers).toHaveLength(0);
  });

  it("parses a CSV export (quotes, commas, parens, formatted dates) to the same shape", () => {
    // Mirrors an Acumatica CSV export: quoted name with a comma, "(20.00)"
    // credit, comma-grouped amounts, and a formatted date instead of a serial.
    const csv = [
      "AR Aging (Detailed)",
      "Company/Branch:,FS",
      ",,,,Aged On:,7/6/2026",
      "",
      "Customer,,Customer Name",
      "ACME001,,\"Acme Corp, Inc.\"",
      "Doc. Type,Ref. Nbr.,Customer Ref.,Branch,Doc. Date,Due Date,Current,1 - 30 Days,31 - 60 Days,61 - 90 Days,Over 90 Days,Balance",
      "Invoice,INV1,r1,FS,6/1/2026,6/8/2026,0,\"1,100.00\",0,0,0,\"1,100.00\"",
      "Credit Memo,CM1,r3,FS,6/2/2026,6/2/2026,0,(20.00),0,0,0,(20.00)",
      ",,,,Customer Total:,,0,\"1,080.00\",0,0,0,\"1,080.00\"",
    ].join("\n");
    const parsed = parseArAgingDetailed(parseCsvGrid(csv));
    expect(parsed.company).toBe("FS");
    expect(parsed.agedOn).toBe("2026-07-06");
    expect(parsed.customers).toHaveLength(1);
    const acme = parsed.customers[0]!;
    expect(acme.customerName).toBe("Acme Corp, Inc."); // comma survived quoting
    expect(acme.buckets.balance).toBe(1080);
    expect(acme.lines.find((l) => l.docType === "Credit Memo")!.buckets.balance).toBe(-20);
  });
});
