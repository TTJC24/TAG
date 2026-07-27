import { describe, expect, it } from "vitest";
import { buildAgingFromInvoices } from "./acumatica-aging.js";
import { pastDue, worstBucket } from "./ar-aging.js";
import type { OpenArInvoice } from "@operating-layer/connectors";

const ASOF = "2026-07-27";

const inv = (o: Partial<OpenArInvoice>): OpenArInvoice => ({
  customerId: "C",
  customerName: "Cust",
  branch: "FS",
  docType: "Invoice",
  refNbr: "R",
  docDate: "2026-01-01",
  dueDate: "2026-07-01",
  balance: 100,
  ...o,
});

describe("buildAgingFromInvoices", () => {
  it("ages by due date and splits FS/BLC into separate companies", () => {
    const invoices: OpenArInvoice[] = [
      // FS: two docs for one customer, different buckets
      inv({ customerId: "ACME", customerName: "Acme", branch: "FS", refNbr: "A1", dueDate: "2026-07-20", balance: 300 }), // 7 days => 1-30
      inv({ customerId: "ACME", customerName: "Acme", branch: "FS", refNbr: "A2", dueDate: "2026-04-01", balance: 700 }), // >90
      inv({ customerId: "CUR", customerName: "Current Co", branch: "FS", refNbr: "A3", dueDate: "2026-08-30", balance: 50 }), // future => current
      // BLC: separate company
      inv({ customerId: "BIG", customerName: "Big Co", branch: "BLC", refNbr: "B1", dueDate: "2026-05-10", balance: 900 }), // >60
      // unmapped branch dropped
      inv({ customerId: "X", branch: "ZZZ", refNbr: "Z1", balance: 999 }),
    ];
    const aging = buildAgingFromInvoices(invoices, ASOF);

    const fs = aging.find((a) => a.company === "FS")!;
    const bl = aging.find((a) => a.company === "BL")!;
    expect(aging).toHaveLength(2); // ZZZ dropped
    expect(fs.agedOn).toBe(ASOF);

    const acme = fs.customers.find((c) => c.customerId === "ACME")!;
    expect(acme.buckets.balance).toBe(1000);
    expect(acme.buckets.d1_30).toBe(300);
    expect(acme.buckets.over90).toBe(700);
    expect(acme.lines).toHaveLength(2);
    expect(pastDue(acme.buckets)).toBe(1000); // all past due
    expect(worstBucket(acme.buckets)).toBe("over90");

    const cur = fs.customers.find((c) => c.customerId === "CUR")!;
    expect(cur.buckets.current).toBe(50);
    expect(pastDue(cur.buckets)).toBe(0);

    expect(bl.customers[0]!.customerId).toBe("BIG");
    expect(bl.customers[0]!.buckets.d61_90).toBe(900);
  });

  it("falls back to customer id when name is missing", () => {
    const aging = buildAgingFromInvoices([inv({ customerId: "NONAME", customerName: null })], ASOF);
    expect(aging[0]!.customers[0]!.customerName).toBe("NONAME");
  });
});
