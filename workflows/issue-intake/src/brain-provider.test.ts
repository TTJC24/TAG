import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUntrustedModelOutput } from "@operating-layer/agents";
import {
  CompanyBrainClient,
  CompanyBrainUnavailableError,
} from "@operating-layer/connectors";
import {
  classificationOutputSchema,
  recommendationOutputSchema,
} from "@operating-layer/schemas";
import { DeterministicModelProvider } from "./agents.js";
import {
  CompanyBrainModelProvider,
  resolveModelProvider,
  toBrainScope,
} from "./brain-provider.js";

const citation = {
  sourceRecordId: "9d8f5f70-0000-4000-8000-000000000001",
  sourceRecordVersionId: "9d8f5f70-0000-4000-8000-000000000002",
  locator: "issues/manual/1",
  excerptHash: "a".repeat(64),
  observedAt: new Date("2026-07-01T00:00:00Z").toISOString(),
};

const classificationRequest = {
  traceId: "trace-brain-test",
  systemInstructions: "classify",
  input: {
    agentKind: "classification" as const,
    entityCode: "BLCS" as const,
    title: "Overdue invoice for a key customer",
    description: "A $125,000 receivable is past due and needs follow-up.",
    financialExposure: 125_000,
    createdByUserId: "20000000-0000-4000-8000-000000000003",
    citation,
  },
  outputSchema: classificationOutputSchema,
  route: {
    provider: "company_brain",
    model: "grounded",
    maxInputTokens: 1,
    maxOutputTokens: 1,
    maxCostUsd: 0,
  },
};

describe("company-brain grounded model provider", () => {
  let server: Server;
  let baseUrl: string;
  let nextResponse: () => { status: number; body: unknown };
  let lastRequestBody: Record<string, unknown> | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        lastRequestBody = raw
          ? (JSON.parse(raw) as Record<string, unknown>)
          : null;
        const { status, body } = nextResponse();
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("stub server did not bind a port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  function provider(): CompanyBrainModelProvider {
    return new CompanyBrainModelProvider(
      new CompanyBrainClient({ baseUrl, timeoutMs: 2_000 }),
    );
  }

  it("keeps deterministic as the default and requires explicit enablement", () => {
    expect(resolveModelProvider({})).toBeInstanceOf(DeterministicModelProvider);
    expect(() =>
      resolveModelProvider({ MODEL_PROVIDER: "company_brain" }),
    ).toThrow(/COMPANY_BRAIN_URL/);
    expect(() => resolveModelProvider({ MODEL_PROVIDER: "live-gpt" })).toThrow(
      /not enabled/,
    );
    expect(
      resolveModelProvider({
        MODEL_PROVIDER: "company_brain",
        COMPANY_BRAIN_URL: baseUrl,
      }),
    ).toBeInstanceOf(CompanyBrainModelProvider);
  });

  it("maps organization codes onto brain memory scopes", () => {
    expect(toBrainScope("FS")).toBe("fs");
    expect(toBrainScope("BLCS")).toBe("blcs");
    expect(toBrainScope("USA")).toBe("usa");
    expect(toBrainScope("CULTIVUS")).toBe("shared");
    expect(toBrainScope(undefined)).toBe("shared");
  });

  it("grounds classification with brain citations and schema-valid output", async () => {
    nextResponse = () => ({
      status: 200,
      body: {
        text: "Customer has 3 open invoices in Acumatica; last payment 62 days ago.",
        citations: [
          {
            slug: "acumatica-invoice-9912",
            source_id: "acumatica",
            title: "Invoice 9912",
            source_uri: null,
          },
        ],
        confidence: "high",
        memories: [],
        intent: "invoice_lookup",
        scope: "blcs",
        resolvedEntity: null,
      },
    });
    const result = await provider().generateStructured(classificationRequest);
    const output = parseUntrustedModelOutput(
      classificationOutputSchema,
      result.output,
    );
    expect(result.model).toBe("company-brain+deterministic-rules-v1");
    expect(output.taskType).toBe("collections"); // business rule stayed in the body
    expect(output.decisionSummary).toContain("company-brain (high)");
    expect(output.decisionSummary).toContain("Invoice 9912");
    expect(output.needsHumanReview).toBe(false);
    expect(lastRequestBody).toMatchObject({ entity: "blcs" });
  });

  it("caps confidence and forces human review when the brain grades low", async () => {
    nextResponse = () => ({
      status: 200,
      body: {
        text: "No strong match found for this customer.",
        citations: [],
        confidence: "low",
      },
    });
    const result = await provider().generateStructured(classificationRequest);
    const output = parseUntrustedModelOutput(
      classificationOutputSchema,
      result.output,
    );
    expect(output.confidence).toBeLessThanOrEqual(0.6);
    expect(output.needsHumanReview).toBe(true);
  });

  it("grounds recommendations under the shared scope", async () => {
    nextResponse = () => ({
      status: 200,
      body: {
        text: "Similar past-due escalations were resolved by branch follow-up.",
        citations: [],
        confidence: "medium",
      },
    });
    const result = await provider().generateStructured({
      ...classificationRequest,
      outputSchema: recommendationOutputSchema,
      input: {
        agentKind: "recommendation" as const,
        title: "Overdue invoice for a key customer",
        description: "Escalate the receivable to the customer contact.",
        taskType: "collections",
        priority: "P1" as const,
        financialExposure: 125_000,
        citation,
      },
    });
    const output = parseUntrustedModelOutput(
      recommendationOutputSchema,
      result.output,
    );
    expect(output.requiresApproval).toBe(true); // body rule, untouched
    expect(output.confidence).toBeLessThanOrEqual(0.85);
    expect(lastRequestBody).toMatchObject({ entity: "shared" });
  });

  it("rejects a malformed brain answer before it can reach persistence", async () => {
    nextResponse = () => ({
      status: 200,
      body: { citations: [], confidence: "high" }, // missing text
    });
    await expect(
      provider().generateStructured(classificationRequest),
    ).rejects.toThrow();
  });

  it("fails closed when the brain is down or unreachable", async () => {
    nextResponse = () => ({ status: 503, body: { error: "down" } });
    await expect(
      provider().generateStructured(classificationRequest),
    ).rejects.toThrow(CompanyBrainUnavailableError);

    const unreachable = new CompanyBrainModelProvider(
      new CompanyBrainClient({
        baseUrl: "http://127.0.0.1:1",
        timeoutMs: 500,
      }),
    );
    await expect(
      unreachable.generateStructured(classificationRequest),
    ).rejects.toThrow(CompanyBrainUnavailableError);
  });
});
