import { describe, expect, it } from "vitest";
import { AcumaticaClient, normalizeArInvoice } from "./acumatica.js";

describe("normalizeArInvoice", () => {
  it("unwraps contract-API {value} fields into the normalized shape", () => {
    const record = {
      Type: { value: "Invoice" },
      ReferenceNbr: { value: "AR001234" },
      Customer: { value: "ACME" },
      CustomerName: { value: "Acme Corp" },
      Branch: { value: "FS" },
      Date: { value: "2026-06-01T00:00:00+00:00" },
      DueDate: { value: "2026-06-15T00:00:00+00:00" },
      Balance: { value: 1200.5 },
      Status: { value: "Open" },
    };
    expect(normalizeArInvoice(record)).toEqual({
      customerId: "ACME",
      customerName: "Acme Corp",
      branch: "FS",
      docType: "Invoice",
      refNbr: "AR001234",
      docDate: "2026-06-01",
      dueDate: "2026-06-15",
      balance: 1200.5,
    });
  });

  it("drops a record missing ref or customer", () => {
    expect(normalizeArInvoice({ ReferenceNbr: { value: "X" } })).toBeNull();
    expect(normalizeArInvoice({ Customer: { value: "Y" } })).toBeNull();
  });
});

describe("AcumaticaClient", () => {
  function fakeResponse(body: unknown, cookies: string[] = []): Response {
    return {
      ok: true,
      status: 200,
      json: async () => body,
      headers: { getSetCookie: () => cookies },
    } as unknown as Response;
  }

  it("logs in (owns its session) then reads open AR read-only", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (String(url).includes("/entity/auth/login")) {
        return fakeResponse(null, ["ASP.NET_SessionId=abc; path=/; HttpOnly"]);
      }
      return fakeResponse([
        {
          Type: { value: "Invoice" },
          ReferenceNbr: { value: "AR1" },
          Customer: { value: "C1" },
          Branch: { value: "FS" },
          DueDate: { value: "2026-06-15" },
          Balance: { value: 500 },
        },
      ]);
    }) as unknown as typeof fetch;

    const client = new AcumaticaClient({
      baseUrl: "https://bigleaguecs.acumatica.com",
      username: "svc",
      password: "secret",
      company: "Production",
      fetchImpl,
    });
    await client.login();
    const invoices = await client.fetchOpenArInvoices();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ customerId: "C1", branch: "FS", balance: 500 });

    // login is a POST; the AR read is a GET carrying the session cookie
    const login = calls.find((c) => c.url.includes("/auth/login"))!;
    expect(login.method).toBe("POST");
    const read = calls.find((c) => c.url.includes("/Invoice"))!;
    expect(read.method).toBe("GET");
    expect(decodeURIComponent(read.url).replace(/\+/g, " ")).toContain(
      "Status eq 'Open'",
    );
  });
});
