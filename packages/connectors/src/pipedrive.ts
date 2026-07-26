import { z } from "zod";

/**
 * Read-only Pipedrive client. GET only — it never writes to Pipedrive, which
 * stays canonical for deal state. One client instance == one Pipedrive account
 * (the group runs two: FS in one, BL+USA in the other), so the caller makes one
 * per account.
 *
 * Every response is untrusted input: the envelope is schema-checked, and each
 * deal is normalized to the lean shape the Sales doorway consumes. The API
 * token is held privately and never logged.
 */

const pipedriveEnvelopeSchema = z
  .object({
    success: z.boolean().optional(),
    data: z.array(z.record(z.unknown())).nullable().optional(),
    additional_data: z
      .object({
        pagination: z
          .object({
            more_items_in_collection: z.boolean().optional(),
            next_start: z.number().nullable().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** The lean deal shape the Sales doorway understands. */
export interface PipedriveDealRecord {
  id: number;
  title: string;
  value: number | null;
  currency: string | null;
  status: string;
  pipeline_id: number | null;
  stage_id: number | null;
  expected_close_date: string | null;
  last_activity_date: string | null;
  next_activity_date: string | null;
  org_name: string | null;
  person_name: string | null;
  owner_name: string | null;
}

function nameOf(value: unknown): string | null {
  if (value && typeof value === "object" && "name" in value) {
    const name = (value as { name?: unknown }).name;
    return name == null ? null : String(name);
  }
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return value == null ? null : String(value);
}

/** Map one raw Pipedrive v1 deal to the doorway's shape. Pure, testable. */
export function normalizePipedriveDeal(
  raw: Record<string, unknown>,
): PipedriveDealRecord | null {
  const id = num(raw.id);
  if (id === null) return null;
  return {
    id,
    title: String(raw.title ?? ""),
    value: num(raw.value),
    currency: str(raw.currency),
    status: String(raw.status ?? "open"),
    pipeline_id: num(raw.pipeline_id),
    stage_id: num(raw.stage_id),
    expected_close_date: str(raw.expected_close_date),
    last_activity_date: str(raw.last_activity_date),
    next_activity_date: str(raw.next_activity_date),
    org_name: nameOf(raw.org_id) ?? str(raw.org_name),
    person_name: nameOf(raw.person_id) ?? str(raw.person_name),
    owner_name: nameOf(raw.user_id) ?? str(raw.owner_name),
  };
}

export class PipedriveUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipedriveUnavailableError";
  }
}

export interface PipedriveClientOptions {
  /** Account base URL, e.g. https://bigleague.pipedrive.com */
  apiBase: string;
  apiToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Max pages to walk, a safety bound. Default 50 (5000 deals). */
  maxPages?: number;
}

export class PipedriveClient {
  private readonly apiBase: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxPages: number;

  constructor(options: PipedriveClientOptions) {
    if (!options.apiBase) throw new Error("Pipedrive apiBase is required");
    if (!options.apiToken) throw new Error("Pipedrive apiToken is required");
    this.apiBase = options.apiBase.replace(/\/+$/, "");
    this.apiToken = options.apiToken;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxPages = options.maxPages ?? 50;
  }

  /** Fetch all open deals for this account (paginated, read-only). */
  async fetchOpenDeals(): Promise<PipedriveDealRecord[]> {
    const deals: PipedriveDealRecord[] = [];
    let start = 0;
    for (let page = 0; page < this.maxPages; page += 1) {
      const url = new URL(`${this.apiBase}/api/v1/deals`);
      url.searchParams.set("status", "open");
      url.searchParams.set("start", String(start));
      url.searchParams.set("limit", "100");
      url.searchParams.set("api_token", this.apiToken);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let body: unknown;
      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new PipedriveUnavailableError(
            `Pipedrive responded ${response.status}`,
          );
        }
        body = await response.json();
      } catch (error) {
        if (error instanceof PipedriveUnavailableError) throw error;
        throw new PipedriveUnavailableError(
          error instanceof Error ? error.message : "Pipedrive request failed",
        );
      } finally {
        clearTimeout(timer);
      }

      const parsed = pipedriveEnvelopeSchema.safeParse(body);
      if (!parsed.success) {
        throw new PipedriveUnavailableError("Pipedrive response failed validation");
      }
      for (const raw of parsed.data.data ?? []) {
        const normalized = normalizePipedriveDeal(raw);
        if (normalized) deals.push(normalized);
      }
      const pagination = parsed.data.additional_data?.pagination;
      if (!pagination?.more_items_in_collection || pagination.next_start == null) {
        break;
      }
      start = pagination.next_start;
    }
    return deals;
  }
}
