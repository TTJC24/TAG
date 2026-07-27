import { describe, expect, it } from "vitest";
import { buildChaseEmail, buildChaseEmailForCustomer } from "./chase-email.js";
import { DEFAULT_LADDER } from "./ar-collections.js";
import type { AgingCustomer } from "./ar-aging.js";

function customer(overrides: Partial<AgingCustomer> = {}): AgingCustomer {
  return {
    customerId: "ACME01",
    customerName: "Acme Corporation",
    email: "ap@acme.example",
    buckets: {
      current: 0,
      d1_30: 1_200.5,
      d31_60: 0,
      d61_90: 0,
      over90: 0,
      balance: 1_200.5,
    },
    lines: [
      {
        docType: "Invoice",
        refNbr: "AR001",
        customerRef: "",
        branch: "FS",
        docDate: "2026-06-01",
        dueDate: "2026-06-15",
        buckets: {
          current: 0,
          d1_30: 1_200.5,
          d31_60: 0,
          d61_90: 0,
          over90: 0,
          balance: 1_200.5,
        },
      },
    ],
    ...overrides,
  };
}

const context = {
  companyName: "Fastening Specialists",
  senderName: "Pat Rivera",
};

describe("buildChaseEmail", () => {
  it("composes an addressed, itemized chase at the friendly rung", () => {
    const proposal = buildChaseEmail(customer(), DEFAULT_LADDER.d1_30, context);

    expect(proposal.to).toBe("ap@acme.example");
    expect(proposal.blockedReason).toBeNull();
    expect(proposal.subject).toBe(
      "Past-due balance $1,200.50 — Fastening Specialists",
    );
    // the customer sees the itemization, the total, and a human signature
    expect(proposal.body).toContain("Hi Acme Corporation,");
    expect(proposal.body).toContain("AR001   due 2026-06-15   $1,200.50");
    expect(proposal.body).toContain("Total past due: $1,200.50");
    expect(proposal.body).toContain("Pat Rivera");
    expect(proposal.body).toContain("Fastening Specialists");
  });

  it("escalates tone and subject as the rung climbs", () => {
    const friendly = buildChaseEmail(customer(), DEFAULT_LADDER.d1_30, context);
    const firm = buildChaseEmail(customer(), DEFAULT_LADDER.d31_60, context);
    const final = buildChaseEmail(customer(), DEFAULT_LADDER.d61_90, context);
    const escalation = buildChaseEmail(customer(), DEFAULT_LADDER.over90, context);

    expect(friendly.body).toContain("quick reminder");
    expect(firm.body).toContain("specific payment date");
    expect(final.subject).toContain("Final notice");
    expect(final.body).toContain("final notice");
    expect(escalation.subject).toContain("URGENT");
    expect(escalation.body).toContain("on hold");

    // every rung stays a proposal — none of them claim to have sent anything
    for (const p of [friendly, firm, final, escalation]) {
      expect(p.body).not.toMatch(/\bsent\b/i);
    }
  });

  it("never invents a recipient when Acumatica has no email on file", () => {
    const withoutEmail = customer();
    delete withoutEmail.email;
    const proposal = buildChaseEmail(
      withoutEmail,
      DEFAULT_LADDER.d1_30,
      context,
    );

    expect(proposal.to).toBeNull();
    expect(proposal.blockedReason).toMatch(/no AR contact email/i);
    // the text is still composed, so a human can address it themselves
    expect(proposal.body).toContain("Acme Corporation");
  });

  it("treats a malformed address as unaddressable rather than guessing", () => {
    const proposal = buildChaseEmail(
      customer({ email: "not-an-address" }),
      DEFAULT_LADDER.d1_30,
      context,
    );
    expect(proposal.to).toBeNull();
    expect(proposal.blockedReason).not.toBeNull();
  });

  it("normalizes the recipient to lowercase for the allowlist check", () => {
    const proposal = buildChaseEmail(
      customer({ email: "  AP@Acme.Example  " }),
      DEFAULT_LADDER.d1_30,
      context,
    );
    expect(proposal.to).toBe("ap@acme.example");
  });

  it("itemizes only past-due lines, oldest first", () => {
    const zero = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0 };
    const multi = customer({
      buckets: { ...zero, d31_60: 500, balance: 1_500 },
      lines: [
        {
          docType: "Invoice",
          refNbr: "NEWER",
          customerRef: "",
          branch: "FS",
          docDate: "2026-06-01",
          dueDate: "2026-06-20",
          buckets: { ...zero, d31_60: 200, balance: 200 },
        },
        {
          docType: "Invoice",
          refNbr: "CURRENT",
          customerRef: "",
          branch: "FS",
          docDate: "2026-07-01",
          dueDate: "2026-08-30",
          buckets: { ...zero, current: 1_000, balance: 1_000 },
        },
        {
          docType: "Invoice",
          refNbr: "OLDER",
          customerRef: "",
          branch: "FS",
          docDate: "2026-05-01",
          dueDate: "2026-05-10",
          buckets: { ...zero, d31_60: 300, balance: 300 },
        },
      ],
    });

    const body = buildChaseEmail(multi, DEFAULT_LADDER.d31_60, context).body;
    // the not-yet-due invoice must never appear in a past-due chase
    expect(body).not.toContain("CURRENT");
    expect(body.indexOf("OLDER")).toBeLessThan(body.indexOf("NEWER"));
  });
});

describe("buildChaseEmailForCustomer", () => {
  it("selects the rung from the worst bucket", () => {
    const zero = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0 };
    const severe = customer({
      buckets: { ...zero, d1_30: 100, over90: 900, balance: 1_000 },
    });
    expect(buildChaseEmailForCustomer(severe, context)?.subject).toContain(
      "URGENT",
    );
  });

  it("returns null when nothing is past due", () => {
    const current = customer({
      buckets: {
        current: 500,
        d1_30: 0,
        d31_60: 0,
        d61_90: 0,
        over90: 0,
        balance: 500,
      },
    });
    expect(buildChaseEmailForCustomer(current, context)).toBeNull();
  });
});
