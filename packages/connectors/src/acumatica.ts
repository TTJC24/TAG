import { z } from "zod";

/**
 * Read-only Acumatica client (contract-based REST API).
 *
 * Acumatica is the source of truth for the group. This client authenticates
 * with its own session (the browser UI cookie does NOT authorize /entity calls)
 * and reads only — the single write it performs is the auth login/logout pair.
 * It never modifies ERP data. One instance == one tenant (`Production`); FS and
 * BLC are branches inside it, so the caller splits by branch downstream.
 *
 * v1 ages open AR documents connector-side (no dependency on a Generic Inquiry
 * being built first): read open AR invoices with a balance, and bucket by due
 * date. The credential is held privately and never logged.
 */

/** Normalized open AR document — what the aging transform consumes. */
export interface OpenArInvoice {
  customerId: string;
  customerName: string | null;
  branch: string; // "FS" | "BLC" | ...
  docType: string; // "Invoice" | "Credit Memo" | ...
  refNbr: string;
  docDate: string | null; // YYYY-MM-DD
  dueDate: string | null; // YYYY-MM-DD
  balance: number; // open balance (signed; credits negative)
}

/** Normalized customer contact — who a chase is addressed to. */
export interface AcumaticaCustomer {
  customerId: string;
  customerName: string | null;
  email: string | null;
  status: string | null;
}

/** Contract-API fields arrive wrapped as {"Field": {"value": ...}}. */
function val(record: Record<string, unknown>, field: string): unknown {
  const cell = record[field];
  if (cell && typeof cell === "object" && "value" in cell) {
    return (cell as { value: unknown }).value;
  }
  return cell ?? null;
}

/**
 * Read a field out of a nested contract-API object, e.g. MainContact.Email.
 * Returns null rather than throwing when the nesting isn't there, so a field
 * that this instance doesn't expose degrades to "no email" instead of a crash.
 */
function nested(
  record: Record<string, unknown>,
  parent: string,
  field: string,
): unknown {
  const branch = record[parent];
  if (!branch || typeof branch !== "object") return null;
  return val(branch as Record<string, unknown>, field);
}

function asStr(v: unknown): string | null {
  return v == null ? null : String(v);
}
function asNum(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number.parseFloat(String(v ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function asDate(v: unknown): string | null {
  const s = asStr(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Map one contract-API AR invoice record to the normalized shape. */
export function normalizeArInvoice(
  record: Record<string, unknown>,
): OpenArInvoice | null {
  const refNbr = asStr(val(record, "ReferenceNbr"));
  const customerId = asStr(val(record, "Customer"));
  if (!refNbr || !customerId) return null;
  return {
    customerId,
    customerName: asStr(val(record, "CustomerName")),
    branch: asStr(val(record, "LinkBranch")) ?? "",
    docType: asStr(val(record, "Type")) ?? "Invoice",
    refNbr,
    docDate: asDate(val(record, "Date")),
    dueDate: asDate(val(record, "DueDate")),
    balance: asNum(val(record, "Balance")),
  };
}

// Validated against build 24.209 / Default 24.200.001 on this instance:
// the AR Invoice entity exposes LinkBranch (not Branch) and has no CustomerName
// (only the Customer id); the Balance filter needs the decimal literal `0M`.
const AR_SELECT =
  "Type,ReferenceNbr,Customer,LinkBranch,Date,DueDate,Balance,Status";
const AR_FILTER = "Status eq 'Open' and Balance gt 0M";

// The Invoice entity carries only the customer *id*, so a chase addressed to a
// human needs the Customer entity: display name and the AR contact email.
// MainContact.Email is the standard location; a top-level Email is tolerated.
// Field names are confirmed against the live instance by acumatica-probe-cli.
const CUSTOMER_SELECT = "CustomerID,CustomerName,Status,MainContact/Email";

/** Map one contract-API Customer record to the normalized contact shape. */
export function normalizeCustomer(
  record: Record<string, unknown>,
): AcumaticaCustomer | null {
  const customerId = asStr(val(record, "CustomerID"));
  if (!customerId) return null;
  const email =
    asStr(nested(record, "MainContact", "Email")) ?? asStr(val(record, "Email"));
  return {
    customerId,
    customerName: asStr(val(record, "CustomerName")),
    email: email && email.includes("@") ? email : null,
    status: asStr(val(record, "Status")),
  };
}

const recordArraySchema = z.array(z.record(z.unknown()));

export class AcumaticaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcumaticaUnavailableError";
  }
}

export interface AcumaticaClientOptions {
  /** e.g. https://bigleaguecs.acumatica.com */
  baseUrl: string;
  username: string;
  password: string;
  company: string; // "Production"
  branch?: string;
  /** Default endpoint version, e.g. "24.200.001". */
  endpointVersion?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  maxPages?: number;
  pageSize?: number;
}

export class AcumaticaClient {
  private readonly baseUrl: string;
  private readonly options: AcumaticaClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly version: string;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private cookies: string[] = [];

  constructor(options: AcumaticaClientOptions) {
    if (!options.baseUrl) throw new Error("Acumatica baseUrl is required");
    if (!options.username || !options.password) {
      throw new Error("Acumatica username and password are required");
    }
    if (!options.company) throw new Error("Acumatica company is required");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.version = options.endpointVersion ?? "24.200.001";
    this.pageSize = options.pageSize ?? 500;
    this.maxPages = options.maxPages ?? 40;
  }

  private async request(
    path: string,
    init: RequestInit & { rawBase?: boolean } = {},
  ): Promise<Response> {
    const url = init.rawBase ? `${this.baseUrl}${path}` : `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        ...(init.headers as Record<string, string>),
      };
      if (this.cookies.length > 0) headers.cookie = this.cookies.join("; ");
      const response = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
      // capture any session cookies
      const set =
        typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie()
          : [];
      if (set.length > 0) {
        this.cookies = set.map((c) => c.split(";")[0]!);
      }
      return response;
    } catch (error) {
      throw new AcumaticaUnavailableError(
        error instanceof Error ? error.message : "Acumatica request failed",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Establish a read session. The client owns its own login. */
  async login(): Promise<void> {
    const response = await this.request("/entity/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: this.options.username,
        password: this.options.password,
        company: this.options.company,
        ...(this.options.branch ? { branch: this.options.branch } : {}),
      }),
    });
    if (!response.ok && response.status !== 204) {
      throw new AcumaticaUnavailableError(`Acumatica login failed (${response.status})`);
    }
    if (this.cookies.length === 0) {
      throw new AcumaticaUnavailableError("Acumatica login returned no session cookie");
    }
  }

  async logout(): Promise<void> {
    try {
      await this.request("/entity/auth/logout", { method: "POST" });
    } catch {
      // best-effort; freeing the session must never fail the run
    }
    this.cookies = [];
  }

  /**
   * Read open AR invoices (balance != 0), paginated. Read-only GET. The exact
   * entity/field names are validated against the live instance on first run;
   * normalizeArInvoice tolerates missing fields.
   */
  async fetchOpenArInvoices(): Promise<OpenArInvoice[]> {
    const invoices: OpenArInvoice[] = [];
    for (let page = 0; page < this.maxPages; page += 1) {
      const params = new URLSearchParams({
        $filter: AR_FILTER,
        $top: String(this.pageSize),
        $skip: String(page * this.pageSize),
        $select: AR_SELECT,
      });
      const response = await this.request(
        `/entity/Default/${this.version}/Invoice?${params.toString()}`,
      );
      if (!response.ok) {
        throw new AcumaticaUnavailableError(
          `Acumatica AR read failed (${response.status})`,
        );
      }
      const parsed = recordArraySchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new AcumaticaUnavailableError("Acumatica AR response failed validation");
      }
      const batch = parsed.data;
      for (const raw of batch) {
        const normalized = normalizeArInvoice(raw);
        if (normalized) invoices.push(normalized);
      }
      if (batch.length < this.pageSize) break;
    }
    return invoices;
  }

  /**
   * Bare read of an entity with NO $select, so the caller can discover which
   * fields this instance actually exposes. Contract-API field names vary by
   * build and customization, and a wrong $select fails as an opaque 500 — so
   * we look before we depend. Read-only GET; used by the probe CLI only.
   */
  async probeEntity(
    entity: string,
    limit = 1,
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ $top: String(limit) });
    const response = await this.request(
      `/entity/Default/${this.version}/${entity}?${params.toString()}`,
    );
    if (!response.ok) {
      throw new AcumaticaUnavailableError(
        `Acumatica ${entity} probe failed (${response.status})`,
      );
    }
    const parsed = recordArraySchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new AcumaticaUnavailableError(
        `Acumatica ${entity} probe response failed validation`,
      );
    }
    return parsed.data;
  }

  /**
   * Read customers, keyed by customer id — the display name and AR contact
   * email a chase is addressed to. Read-only GET, paginated like the AR read.
   *
   * Degrades rather than fails: a customer with no email simply has none, and
   * the caller decides what to do (we hold those chases back from drafting
   * instead of guessing an address).
   */
  async fetchCustomers(): Promise<Map<string, AcumaticaCustomer>> {
    const byId = new Map<string, AcumaticaCustomer>();
    for (let page = 0; page < this.maxPages; page += 1) {
      const params = new URLSearchParams({
        $top: String(this.pageSize),
        $skip: String(page * this.pageSize),
        $select: CUSTOMER_SELECT,
      });
      const response = await this.request(
        `/entity/Default/${this.version}/Customer?${params.toString()}`,
      );
      if (!response.ok) {
        throw new AcumaticaUnavailableError(
          `Acumatica customer read failed (${response.status})`,
        );
      }
      const parsed = recordArraySchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new AcumaticaUnavailableError(
          "Acumatica customer response failed validation",
        );
      }
      const batch = parsed.data;
      for (const raw of batch) {
        const normalized = normalizeCustomer(raw);
        if (normalized) byId.set(normalized.customerId, normalized);
      }
      if (batch.length < this.pageSize) break;
    }
    return byId;
  }
}
