import { describe, expect, it } from "vitest";
import {
  AcumaticaClient,
  normalizeArInvoice,
  normalizeCustomer,
  usableRecipient,
} from "./acumatica.js";

describe("normalizeCustomer", () => {
  it("pulls the AR contact email out of the nested MainContact", () => {
    expect(
      normalizeCustomer({
        CustomerID: { value: "ACME01" },
        CustomerName: { value: "Acme Corporation" },
        Status: { value: "Active" },
        MainContact: { Email: { value: "ap@acme.example" } },
      }),
    ).toEqual({
      customerId: "ACME01",
      customerName: "Acme Corporation",
      email: "ap@acme.example",
      status: "Active",
    });
  });

  it("degrades to no email rather than failing when the contact is absent", () => {
    const customer = normalizeCustomer({
      CustomerID: { value: "NOEMAIL" },
      CustomerName: { value: "No Contact Co" },
    });
    expect(customer).toMatchObject({ customerId: "NOEMAIL", email: null });
  });

  it("rejects a value that is not an address", () => {
    const customer = normalizeCustomer({
      CustomerID: { value: "X" },
      MainContact: { Email: { value: "n/a" } },
    });
    expect(customer?.email).toBeNull();
  });

  it("rejects the malformed shapes ERP contact fields actually hold", () => {
    for (const bad of [
      "Acme AP <ap@acme.com>",
      "ap@acme",
      "ap@acme.com,ar@acme.com",
      "ap @acme.com",
      "ap@acme.com\r\nBcc: x@y.co",
      "",
      "-",
    ]) {
      expect(
        usableRecipient(bad),
        `should reject ${JSON.stringify(bad)}`,
      ).toBeNull();
    }
  });

  it("accepts and normalizes a usable address", () => {
    expect(usableRecipient("  AP@Acme.Example  ")).toBe("ap@acme.example");
  });

  it("drops a record with no customer id", () => {
    expect(normalizeCustomer({ CustomerName: { value: "Orphan" } })).toBeNull();
  });
});

describe("normalizeArInvoice", () => {
  it("unwraps contract-API {value} fields into the normalized shape", () => {
    const record = {
      Type: { value: "Invoice" },
      ReferenceNbr: { value: "AR001234" },
      Customer: { value: "ACME" },
      CustomerName: { value: "Acme Corp" },
      LinkBranch: { value: "FS" },
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
          LinkBranch: { value: "FS" },
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
    expect(invoices[0]).toMatchObject({
      customerId: "C1",
      branch: "FS",
      balance: 500,
    });

    // login is a POST; the AR read is a GET carrying the session cookie
    const login = calls.find((c) => c.url.includes("/auth/login"))!;
    expect(login.method).toBe("POST");
    const read = calls.find((c) => c.url.includes("/Invoice"))!;
    expect(read.method).toBe("GET");
    expect(decodeURIComponent(read.url).replace(/\+/g, " ")).toContain(
      "Status eq 'Open'",
    );
  });

  it("reads customers read-only and keys them by customer id", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (String(url).includes("/entity/auth/login")) {
        return fakeResponse(null, ["ASP.NET_SessionId=abc; path=/; HttpOnly"]);
      }
      return fakeResponse([
        {
          CustomerID: { value: "C1" },
          CustomerName: { value: "Customer One" },
          MainContact: { Email: { value: "one@example.test" } },
        },
        {
          CustomerID: { value: "C2" },
          CustomerName: { value: "Customer Two" },
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
    const customers = await client.fetchCustomers();

    expect(customers.size).toBe(2);
    expect(customers.get("C1")?.email).toBe("one@example.test");
    expect(customers.get("C2")?.email).toBeNull();

    const read = calls.find((c) => c.url.includes("/Customer"))!;
    expect(read.method).toBe("GET");
  });
});
