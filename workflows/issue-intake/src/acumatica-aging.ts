import type { OpenArInvoice } from "@operating-layer/connectors";
import type { AgingBuckets, AgingCustomer, ParsedAging } from "./ar-aging.js";

/**
 * Turn open AR invoices read from Acumatica into the same ParsedAging shape the
 * Collections doorway already consumes — so the file path and the live-ERP path
 * feed one, proven pipeline. Aging is computed connector-side (days past due
 * from the document's due date), and split by branch: FS -> FS, BLC -> BL
 * (which the Collections doorway then maps to org codes FS and BLCS).
 */

export const DEFAULT_BRANCH_TO_COMPANY: Record<string, string> = {
  FS: "FS",
  BLC: "BL",
  BL: "BL",
};

function daysPastDue(dueDate: string | null, asOf: string): number | null {
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T00:00:00Z`).getTime();
  const at = new Date(`${asOf}T00:00:00Z`).getTime();
  if (Number.isNaN(due) || Number.isNaN(at)) return null;
  return Math.round((at - due) / 86_400_000);
}

function bucketFor(balance: number, days: number | null): AgingBuckets {
  const b: AgingBuckets = {
    current: 0,
    d1_30: 0,
    d31_60: 0,
    d61_90: 0,
    over90: 0,
    balance,
  };
  if (days === null || days <= 0) b.current = balance;
  else if (days <= 30) b.d1_30 = balance;
  else if (days <= 60) b.d31_60 = balance;
  else if (days <= 90) b.d61_90 = balance;
  else b.over90 = balance;
  return b;
}

function addInto(total: AgingBuckets, part: AgingBuckets): void {
  total.current += part.current;
  total.d1_30 += part.d1_30;
  total.d31_60 += part.d31_60;
  total.d61_90 += part.d61_90;
  total.over90 += part.over90;
  total.balance += part.balance;
}

/**
 * Group open AR invoices into one ParsedAging per company (branch), each ready
 * for the Collections doorway's syncArAging. Invoices on an unmapped branch are
 * skipped (e.g. a branch we don't chase).
 */
export function buildAgingFromInvoices(
  invoices: OpenArInvoice[],
  asOf: string,
  opts: {
    branchToCompany?: Record<string, string>;
    /** customerId -> contact, from AcumaticaClient.fetchCustomers(). */
    contacts?: Map<
      string,
      { customerName: string | null; email: string | null }
    >;
  } = {},
): ParsedAging[] {
  const branchMap = opts.branchToCompany ?? DEFAULT_BRANCH_TO_COMPANY;
  const contacts = opts.contacts;
  const byCompany = new Map<string, Map<string, AgingCustomer>>();

  for (const inv of invoices) {
    const company = branchMap[inv.branch.trim().toUpperCase()];
    if (!company) continue;
    let customers = byCompany.get(company);
    if (!customers) {
      customers = new Map();
      byCompany.set(company, customers);
    }
    let customer = customers.get(inv.customerId);
    if (!customer) {
      // The Invoice entity has no customer name, so prefer the Customer entity
      // read; fall back to the raw id only when we genuinely have no better label.
      const contact = contacts?.get(inv.customerId);
      customer = {
        customerId: inv.customerId,
        customerName:
          contact?.customerName ?? inv.customerName ?? inv.customerId,
        ...(contact?.email ? { email: contact.email } : {}),
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
      customers.set(inv.customerId, customer);
    }
    const lineBuckets = bucketFor(inv.balance, daysPastDue(inv.dueDate, asOf));
    customer.lines.push({
      docType: inv.docType,
      refNbr: inv.refNbr,
      customerRef: "",
      branch: inv.branch,
      docDate: inv.docDate,
      dueDate: inv.dueDate,
      buckets: lineBuckets,
    });
    addInto(customer.buckets, lineBuckets);
  }

  return [...byCompany.entries()].map(([company, customers]) => ({
    company,
    agedOn: asOf,
    customers: [...customers.values()],
  }));
}
