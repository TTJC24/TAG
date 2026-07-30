import { describe, expect, it } from "vitest";
import {
  checkAcumatica,
  checkMailWire,
  checkPipedriveSource,
  renderReport,
  summarize,
  type AcumaticaProbe,
  type CheckResult,
} from "./preflight.js";

/**
 * The preflight harness needs its own tests: a health check that reports a
 * false PASS is worse than no health check, and one that reports a false FAIL
 * trains people to ignore it.
 */

function fakeAcumatica(
  overrides: Partial<AcumaticaProbe> = {},
): AcumaticaProbe {
  return {
    login: async () => {},
    logout: async () => {},
    probeEntity: async (entity) =>
      entity === "Invoice"
        ? [
            {
              Type: {},
              ReferenceNbr: {},
              Customer: {},
              LinkBranch: {},
              DueDate: {},
              Balance: {},
              Status: {},
            },
          ]
        : [{ CustomerID: {}, CustomerName: {}, Status: {}, MainContact: {} }],
    fetchOpenArInvoices: async () => [
      {
        customerId: "A",
        branch: "FS",
        balance: 1_000,
        dueDate: "2026-05-01",
        docType: "Invoice",
      },
      {
        customerId: "A",
        branch: "FS",
        balance: -250,
        dueDate: "2026-05-01",
        docType: "Credit Memo",
      },
    ],
    fetchCustomers: async () =>
      new Map([
        ["A", { customerName: "Acme", email: "ap@acme.test" }],
        ["B", { customerName: "Beta", email: null }],
      ]),
    ...overrides,
  };
}

const statusOf = (results: CheckResult[], name: string) =>
  results.find((r) => r.name === name)?.status;

describe("checkAcumatica", () => {
  it("passes a healthy instance and reports what it saw", async () => {
    const results = await checkAcumatica(fakeAcumatica());

    expect(statusOf(results, "authenticates")).toBe("pass");
    expect(statusOf(results, "Invoice fields present")).toBe("pass");
    expect(statusOf(results, "Customer fields present")).toBe("pass");
    expect(statusOf(results, "open AR read")).toBe("pass");
    expect(statusOf(results, "credit documents included")).toBe("pass");

    const ar = results.find((r) => r.name === "open AR read")!;
    expect(ar.evidence).toMatchObject({ documents: 2, branches: ["FS"] });
  });

  it("skips the rest when login fails rather than cascading failures", async () => {
    const results = await checkAcumatica(
      fakeAcumatica({
        login: async () => {
          throw new Error("401 unauthorized");
        },
      }),
    );

    expect(statusOf(results, "authenticates")).toBe("fail");
    expect(statusOf(results, "remaining acumatica checks")).toBe("skip");
    // it must not claim anything about AR when it never got in
    expect(results.some((r) => r.name === "open AR read")).toBe(false);
  });

  it("fails when a field Collections depends on is missing", async () => {
    const results = await checkAcumatica(
      fakeAcumatica({
        // LinkBranch absent — the field the FS/BLC split relies on
        probeEntity: async () => [
          {
            Type: {},
            ReferenceNbr: {},
            Customer: {},
            DueDate: {},
            Balance: {},
            Status: {},
          },
        ],
      }),
    );
    const invoice = results.find((r) => r.name === "Invoice fields present")!;
    expect(invoice.status).toBe("fail");
    expect(invoice.detail).toContain("LinkBranch");
  });

  it("warns rather than fails when credits are absent, since that may be genuine", async () => {
    const results = await checkAcumatica(
      fakeAcumatica({
        fetchOpenArInvoices: async () => [
          {
            customerId: "A",
            branch: "FS",
            balance: 500,
            dueDate: "2026-05-01",
            docType: "Invoice",
          },
        ],
      }),
    );
    expect(statusOf(results, "credit documents included")).toBe("warn");
  });

  it("warns when few customers have a usable email, and fails when none load", async () => {
    const sparse = await checkAcumatica(
      fakeAcumatica({
        fetchCustomers: async () =>
          new Map([
            ["A", { customerName: "Acme", email: null }],
            ["B", { customerName: "Beta", email: null }],
            ["C", { customerName: "Gamma", email: "c@c.test" }],
          ]),
      }),
    );
    const sparseCheck = sparse.find(
      (r) => r.name === "customer contacts read",
    )!;
    expect(sparseCheck.status).toBe("warn");
    expect(sparseCheck.evidence).toMatchObject({ percent: 33 });

    const none = await checkAcumatica(
      fakeAcumatica({ fetchCustomers: async () => new Map() }),
    );
    expect(statusOf(none, "customer contacts read")).toBe("fail");
  });

  it("always logs out, even when a check throws", async () => {
    let loggedOut = false;
    await checkAcumatica(
      fakeAcumatica({
        logout: async () => {
          loggedOut = true;
        },
        fetchOpenArInvoices: async () => {
          throw new Error("read blew up");
        },
      }),
    );
    expect(loggedOut).toBe(true);
  });
});

describe("checkPipedriveSource", () => {
  it("flags pipelines that are present but unmapped, since those deals vanish", async () => {
    const results = await checkPipedriveSource(
      "BL-USA",
      {
        fetchOpenDeals: async () => [
          { pipeline_id: 1 },
          { pipeline_id: 1 },
          { pipeline_id: 99 },
        ],
      },
      { pipelineToOrgCode: { "1": "BLCS" } },
    );

    const routing = results.find((r) => r.name.includes("pipeline routing"))!;
    expect(routing.status).toBe("warn");
    expect(routing.detail).toContain("99");
  });

  it("passes when every pipeline present is mapped", async () => {
    const results = await checkPipedriveSource(
      "BL-USA",
      { fetchOpenDeals: async () => [{ pipeline_id: 1 }, { pipeline_id: 2 }] },
      { pipelineToOrgCode: { "1": "BLCS", "2": "USA" } },
    );
    expect(
      results.find((r) => r.name.includes("pipeline routing"))?.status,
    ).toBe("pass");
  });

  it("warns rather than fails on an empty but authenticated account", async () => {
    const results = await checkPipedriveSource(
      "FS",
      { fetchOpenDeals: async () => [] },
      { orgCode: "FS" },
    );
    expect(results[0]!.status).toBe("warn");
  });
});

describe("checkMailWire", () => {
  it("reports the Outlook wire as not implemented rather than silently passing", () => {
    const [result] = checkMailWire({});
    expect(result!.status).toBe("skip");
    expect(result!.detail).toMatch(/not implemented/i);
    expect(result!.evidence).toMatchObject({
      implemented: false,
      provider: "microsoft-365",
    });
  });

  it("warns if the flag is set while no connector exists", () => {
    const [result] = checkMailWire({ OUTLOOK_DRAFT_ENABLED: "true" });
    expect(result!.status).toBe("warn");
  });
});

describe("summarize and renderReport", () => {
  const results: CheckResult[] = [
    { section: "a", name: "one", status: "pass", detail: "ok" },
    { section: "a", name: "two", status: "warn", detail: "hmm" },
    { section: "b", name: "three", status: "fail", detail: "broken" },
    { section: "b", name: "four", status: "skip", detail: "not configured" },
  ];

  it("counts by status and treats only failures as blocking", () => {
    const report = summarize(results);
    expect(report).toMatchObject({
      passed: 1,
      warned: 1,
      failed: 1,
      skipped: 1,
      ok: false,
    });
  });

  it("is ok when there are warnings but no failures", () => {
    expect(summarize(results.filter((r) => r.status !== "fail")).ok).toBe(true);
  });

  it("renders every check under its section with a clear verdict", () => {
    const text = renderReport(summarize(results));
    expect(text).toContain("── A ──");
    expect(text).toContain("── B ──");
    expect(text).toContain("FAIL  three");
    expect(text).toContain("FAILURES PRESENT");
  });
});
