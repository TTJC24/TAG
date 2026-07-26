import { z } from "zod";

/**
 * Read-only client for the company-brain knowledge platform.
 *
 * company-brain is the group's knowledge layer (M365 / Acumatica / Pipedrive
 * ingested into one searchable store). This client speaks its `POST /ask`
 * protocol and treats every answer as untrusted input: the response must pass
 * the schema below before any caller sees it. The client never writes.
 */

export const companyBrainScopeSchema = z.enum(["fs", "blcs", "usa", "shared"]);
export type CompanyBrainScope = z.infer<typeof companyBrainScopeSchema>;

export const companyBrainCitationSchema = z
  .object({
    slug: z.string().min(1),
    source_id: z.string().min(1),
    title: z.string().nullable(),
    source_uri: z.string().nullable(),
  })
  .passthrough();
export type CompanyBrainCitation = z.infer<typeof companyBrainCitationSchema>;

export const companyBrainAnswerSchema = z
  .object({
    text: z.string().min(1),
    citations: z.array(companyBrainCitationSchema),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .passthrough();
export type CompanyBrainAnswer = z.infer<typeof companyBrainAnswerSchema>;

export interface CompanyBrainClientOptions {
  baseUrl: string;
  /** Extra headers, e.g. a Cloudflare Access service token. Never logged. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface CompanyBrainAskRequest {
  question: string;
  entity?: CompanyBrainScope;
  sources?: string[];
  limit?: number;
}

export class CompanyBrainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyBrainUnavailableError";
  }
}

export class CompanyBrainClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CompanyBrainClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async ask(request: CompanyBrainAskRequest): Promise<CompanyBrainAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body: JSON.stringify({
          question: request.question,
          entity: request.entity,
          sources: request.sources,
          limit: request.limit,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new CompanyBrainUnavailableError(
        `company-brain is unreachable: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new CompanyBrainUnavailableError(
        `company-brain answered HTTP ${response.status}`,
      );
    }
    const raw: unknown = await response.json().catch(() => {
      throw new CompanyBrainUnavailableError(
        "company-brain returned a non-JSON body",
      );
    });
    // Untrusted input boundary: reject anything that does not match.
    return companyBrainAnswerSchema.parse(raw);
  }
}
