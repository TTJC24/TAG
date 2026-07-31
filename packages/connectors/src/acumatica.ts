import { z } from "zod";
import {
  AuthCircuitBreaker,
  classifyAuthFailure,
  type AuthFailureKind,
} from "./auth-guard.js";

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

/**
 * The one definition of a usable recipient, matching the CHECK constraint on
 * collections_chase_proposals.recipient and Mail's own address rule.
 *
 * ERP contact fields hold things like "Acme AP <ap@acme.com>", "ap@acme" with
 * no dot, or two addresses comma-separated. A looser test here would let those
 * through to a database CHECK that rejects the whole row — which would throw
 * away the drafted body too, exactly for the customers the fallback exists to
 * handle. Reject early and degrade to "no address on file" instead.
 */
const RECIPIENT_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The address if it is usable as-is, else null. Never a guess or a repair. */
export function usableRecipient(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return RECIPIENT_PATTERN.test(trimmed) ? trimmed : null;
}

/** Normalized customer contact — who a chase is addressed to. */
export interface AcumaticaCustomer {
  customerId: string;
  customerName: string | null;
  email: string | null;
  status: string | null;
}

/**
 * A ship-to location under a customer.
 *
 * This matters for identity, not just delivery: one legal customer can have
 * many physical yards, and downstream systems tend to flatten that into many
 * look-alike company records. Keeping locations as children of a single
 * customer id is what makes those records resolvable instead of ambiguous.
 */
export interface AcumaticaCustomerLocation {
  customerId: string;
  locationId: string;
  locationName: string | null;
  status: string | null;
  /** Which of our branches serves this site. */
  shippingBranch: string | null;
  active: boolean | null;
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
// Deliberately NOT filtered to `Balance gt 0M`. That excluded credit memos and
// unapplied payments, so a customer holding an $8,000 credit against a $10,000
// past-due invoice would be told they owe the full $10,000 — tolerable when the
// output was an internal to-do, wrong now that it is the text proposed to the
// customer at "final notice". Read every open document and net per customer.
const AR_FILTER = "Status eq 'Open'";

// The Invoice entity carries only the customer *id*, so a chase addressed to a
// human needs the Customer entity: display name and the AR contact email.
// MainContact.Email is the standard location; a top-level Email is tolerated.
// Field names are confirmed against the live instance by acumatica-probe-cli.
const CUSTOMER_SELECT = "CustomerID,CustomerName,Status,MainContact/Email";

// Confirmed against the live instance by acumatica-probe-cli. Two corrections
// from the first guess: the customer reference is `Customer`, not `CustomerID`,
// and the entity exposes NO address object — so location city/state are simply
// not available here. `ShippingBranch` is, and is more useful for identity
// anyway, since it says which of our branches serves that site.
const CUSTOMER_LOCATION_SELECT =
  "Customer,LocationID,LocationName,Active,Status,ShippingBranch";

/** Map one contract-API CustomerLocation record to the normalized shape. */
export function normalizeCustomerLocation(
  record: Record<string, unknown>,
): AcumaticaCustomerLocation | null {
  const customerId = asStr(val(record, "Customer"));
  const locationId = asStr(val(record, "LocationID"));
  if (!customerId || !locationId) return null;
  const active = val(record, "Active");
  return {
    customerId,
    locationId,
    locationName: asStr(val(record, "LocationName")),
    status: asStr(val(record, "Status")),
    shippingBranch: asStr(val(record, "ShippingBranch")),
    active: typeof active === "boolean" ? active : null,
  };
}

/** Map one contract-API Customer record to the normalized contact shape. */
export function normalizeCustomer(
  record: Record<string, unknown>,
): AcumaticaCustomer | null {
  const customerId = asStr(val(record, "CustomerID"));
  if (!customerId) return null;
  const email =
    asStr(nested(record, "MainContact", "Email")) ??
    asStr(val(record, "Email"));
  return {
    customerId,
    customerName: asStr(val(record, "CustomerName")),
    email: usableRecipient(email),
    status: asStr(val(record, "Status")),
  };
}

const recordArraySchema = z.array(z.record(z.unknown()));

/** A Response whose body was consumed inside the timeout window. */
type ResponseWithJson = Response & { parsedJson?: unknown };

/** Raised when a paginated read hits its page cap — never truncate silently. */
export class AcumaticaTruncatedError extends Error {
  constructor(entity: string, limit: number) {
    super(
      `Acumatica ${entity} read hit the ${limit}-record page cap; raise maxPages/pageSize rather than trusting a partial read`,
    );
    this.name = "AcumaticaTruncatedError";
  }
}

/**
 * The session was lost mid-run and the client has stopped making requests.
 * Distinct from AcumaticaUnavailableError so callers can tell "the server is
 * unhappy" apart from "we deliberately stopped to protect the account".
 */
export class AcumaticaSessionInvalidatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcumaticaSessionInvalidatedError";
  }
}

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
  /**
   * Gate on authentication. Required for production: without it a restarted
   * process will happily re-authenticate into a failing state and drive the
   * account toward lockout again.
   */
  breaker?: AuthCircuitBreaker;
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
  /**
   * Cookie jar keyed by NAME, deliberately.
   *
   * Acumatica's login sets several cookies (session id, auth token, branch,
   * company). A later response often re-sets only one of them. Storing the jar
   * as a flat list and replacing it wholesale therefore discarded the auth
   * cookie the moment any single cookie came back — which looked like the first
   * read succeeding and every read after it returning 401.
   */
  private cookies = new Map<string, string>();
  /**
   * Set once a request comes back 401. Every further request is then refused
   * LOCALLY, without touching the network.
   *
   * This is a safety interlock, not an optimisation. An unauthenticated request
   * to /entity counts against Acumatica's failed-login threshold, so a client
   * that keeps making calls after losing its session will lock the service
   * account out — which is exactly what happened here, twice. One bad request
   * is a bug; four in a row is an outage.
   */
  private sessionInvalidated = false;

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
    init: RequestInit & { rawBase?: boolean; consumeJson?: boolean } = {},
  ): Promise<Response> {
    if (this.sessionInvalidated && !path.includes("/entity/auth/")) {
      throw new AcumaticaSessionInvalidatedError(
        "Acumatica session is no longer authenticated; refusing further requests so they cannot count against the account lockout threshold",
      );
    }
    const url = init.rawBase
      ? `${this.baseUrl}${path}`
      : `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Whether the server answered at all. A failure after this point has
    // already been classified from its status, and must not be re-recorded by
    // the catch below as a transport failure — one request producing two
    // entries makes the operator's failure count a fiction, and the second,
    // vaguer entry overwrites the first, more useful one.
    let responded = false;
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        ...(init.headers as Record<string, string>),
      };
      if (this.cookies.size > 0) {
        headers.cookie = [...this.cookies]
          .map(([name, value]) => `${name}=${value}`)
          .join("; ");
      }
      const response = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
      responded = true;
      // A 401 means the session is gone. Latch it so nothing else is sent.
      if (response.status === 401) this.sessionInvalidated = true;

      // Classify and record every unsuccessful response on a non-auth path.
      // The kinds are deliberately not equivalent: a 401 here is the shape that
      // preceded the account lockout and must stop the next run, while a 403 is
      // a permissions fact and a 429 is back-pressure — neither is a security
      // event and neither may block tomorrow's run.
      //
      // Auth paths are excluded because login() classifies its own failure from
      // the response body; recording here as well would count one failure twice.
      const isAuthPath = path.includes("/entity/auth/");
      if (!response.ok && response.status !== 204 && !isAuthPath) {
        this.options.breaker?.recordFailure(
          classifyAuthFailure(response.status, ""),
          `HTTP ${response.status} from ${path.split("?")[0]}`,
        );
      }

      // Merge any Set-Cookie into the jar by name. Never replace the jar: a
      // response that re-sets one cookie must not evict the others.
      const set =
        typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie()
          : [];
      for (const raw of set) {
        const pair = raw.split(";")[0] ?? "";
        const separator = pair.indexOf("=");
        if (separator <= 0) continue;
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1);
        // An expired/blanked cookie is the server dropping it; honour that.
        if (value === "") this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
      if (init.consumeJson) {
        // Read the body while the abort timer is still armed. Clearing the
        // timeout as soon as headers arrive would leave a server that sends
        // 200 and then stalls the body hanging forever, with no abort and no
        // error — which in a scheduled worker is a silent, permanent outage.
        //
        // Parse from text rather than response.json() so a non-JSON body says
        // what it actually was. Bare `.json()` reports "Unexpected end of JSON
        // input", which tells an operator nothing about whether the server
        // returned empty, an HTML error page, or a truncated response.
        const text = await response.text();
        try {
          (response as ResponseWithJson).parsedJson =
            text.length === 0 ? null : JSON.parse(text);
        } catch {
          throw new AcumaticaUnavailableError(
            `Acumatica returned a non-JSON body (HTTP ${response.status}, ${text.length} bytes): ${
              text.length === 0 ? "<empty>" : `${text.slice(0, 200)}…`
            }`,
          );
        }
      }
      return response;
    } catch (error) {
      // A request that never got an answer is recorded but does NOT trip the
      // breaker. Note the honest limitation: an aborted login may still have
      // reached the server and counted against the lockout threshold, so this
      // is a judgement call — tripping on every network blip would turn a
      // transient outage into a manual reset, and that trade is only acceptable
      // because a real lockout also produces a 401 or a 5xx, both of which do
      // trip. An operator reviewing a lockout should still read these.
      if (!responded) {
        this.options.breaker?.recordFailure(
          "transport",
          `no response from ${path.split("?")[0]}: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
      throw new AcumaticaUnavailableError(
        error instanceof Error ? error.message : "Acumatica request failed",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Establish a read session. The client owns its own login. */
  async login(): Promise<void> {
    // Refuse before touching the network. A blocked breaker means a previous
    // run ended in a way that may have counted against the account, and only a
    // deliberate operator action may start another attempt.
    this.options.breaker?.assertMayAuthenticate();
    this.sessionInvalidated = false;
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
      // Include what the server actually said. Acumatica returns a JSON body on
      // a failed login naming the real cause — most often a concurrent-session
      // or licence limit rather than a bad credential — and a bare status code
      // sends an operator hunting the wrong problem. The credential itself is
      // never in that body, so this is safe to surface.
      let body = "";
      try {
        body = await response.text();
      } catch {
        // body already consumed or unreadable; the status alone will have to do
      }
      // Distinguish the kinds. Only those that plausibly count against an
      // authentication threshold trip the breaker; a 429 must not, or
      // back-pressure would look like a security event.
      const kind: AuthFailureKind = classifyAuthFailure(response.status, body);
      const detail = body ? `: ${body.slice(0, 300)}` : "";
      this.options.breaker?.recordFailure(
        kind,
        `login failed (${response.status})${detail}`,
      );
      throw new AcumaticaUnavailableError(
        `Acumatica login failed (${response.status}, ${kind})${detail}`,
      );
    }
    if (this.cookies.size === 0) {
      this.options.breaker?.recordFailure(
        "unauthorized",
        "login returned no session cookie",
      );
      throw new AcumaticaUnavailableError(
        "Acumatica login returned no session cookie",
      );
    }
    this.options.breaker?.recordSuccess();
  }

  async logout(): Promise<void> {
    try {
      await this.request("/entity/auth/logout", { method: "POST" });
    } catch {
      // best-effort; freeing the session must never fail the run
    }
    this.cookies.clear();
  }

  /** One page of records, with the body read inside the timeout window. */
  private async readPage(
    entity: string,
    params: URLSearchParams,
  ): Promise<Record<string, unknown>[]> {
    const response = await this.request(
      `/entity/Default/${this.version}/${entity}?${params.toString()}`,
      { consumeJson: true },
    );
    if (!response.ok) {
      throw new AcumaticaUnavailableError(
        `Acumatica ${entity} read failed (${response.status})`,
      );
    }
    const body = (response as ResponseWithJson).parsedJson;
    const parsed = recordArraySchema.safeParse(body);
    if (!parsed.success) {
      // Say what came back. "failed validation" alone leaves an operator with
      // no way to tell an empty response from a wrong-shaped one.
      const shape =
        body === null || body === undefined
          ? "empty body"
          : Array.isArray(body)
            ? "an array with unexpected element types"
            : `a ${typeof body}: ${JSON.stringify(body).slice(0, 200)}`;
      throw new AcumaticaUnavailableError(
        `Acumatica ${entity} returned ${shape} where a record array was expected`,
      );
    }
    return parsed.data;
  }

  /**
   * Read every page of an entity. Throws rather than returning a partial read:
   * a silently truncated AR read would understate what a customer owes, and a
   * silently truncated customer read would strip names and addresses off
   * chases with nothing anywhere saying why.
   */
  private async readAllPages(
    entity: string,
    baseParams: Record<string, string>,
  ): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    for (let page = 0; page < this.maxPages; page += 1) {
      const batch = await this.readPage(
        entity,
        new URLSearchParams({
          ...baseParams,
          $top: String(this.pageSize),
          $skip: String(page * this.pageSize),
        }),
      );
      all.push(...batch);
      if (batch.length < this.pageSize) return all;
    }
    throw new AcumaticaTruncatedError(entity, this.maxPages * this.pageSize);
  }

  /**
   * Read open AR documents, paginated. Read-only GET.
   *
   * Includes credit memos and unapplied payments (negative balances), not just
   * invoices: the caller nets them per customer, so a customer is never told
   * they owe a gross figure that ignores credits already on their account.
   */
  async fetchOpenArInvoices(): Promise<OpenArInvoice[]> {
    const rows = await this.readAllPages("Invoice", {
      $filter: AR_FILTER,
      $select: AR_SELECT,
    });
    const invoices: OpenArInvoice[] = [];
    for (const raw of rows) {
      const normalized = normalizeArInvoice(raw);
      // A zero-balance document is settled; it is not part of what is owed.
      if (normalized && normalized.balance !== 0) invoices.push(normalized);
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
    return this.readPage(entity, new URLSearchParams({ $top: String(limit) }));
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
    const rows = await this.readAllPages("Customer", {
      $select: CUSTOMER_SELECT,
    });
    const byId = new Map<string, AcumaticaCustomer>();
    for (const raw of rows) {
      const normalized = normalizeCustomer(raw);
      if (normalized) byId.set(normalized.customerId, normalized);
    }
    return byId;
  }

  /**
   * Read ship-to locations, grouped by customer id. Read-only GET.
   *
   * Separate from fetchCustomers because this entity is more instance-specific:
   * a tenant that does not use multi-location customers may not expose it at
   * all. The caller decides whether an absent location entity is fatal — for an
   * identity export it is a degradation worth reporting, not a failure.
   */
  async fetchCustomerLocations(): Promise<
    Map<string, AcumaticaCustomerLocation[]>
  > {
    const rows = await this.readAllPages("CustomerLocation", {
      $select: CUSTOMER_LOCATION_SELECT,
    });
    const byCustomer = new Map<string, AcumaticaCustomerLocation[]>();
    for (const raw of rows) {
      const normalized = normalizeCustomerLocation(raw);
      if (!normalized) continue;
      const existing = byCustomer.get(normalized.customerId);
      if (existing) existing.push(normalized);
      else byCustomer.set(normalized.customerId, [normalized]);
    }
    return byCustomer;
  }
}
