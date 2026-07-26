import { describe, expect, it } from "vitest";
import { normalizePipedriveDeal, PipedriveClient } from "./pipedrive.js";

describe("normalizePipedriveDeal", () => {
  it("maps a v1 deal (nested org/person/user, string value) to the lean shape", () => {
    const raw = {
      id: 42,
      title: "Oakland Park CIPP",
      value: "250000", // v1 sometimes stringifies
      currency: "USD",
      status: "open",
      pipeline_id: 3,
      stage_id: 9,
      expected_close_date: "2026-09-10",
      last_activity_date: "2026-07-20",
      next_activity_date: null,
      org_id: { name: "City of Oakland Park", value: 100 },
      person_id: { name: "Jane Roe" },
      user_id: { name: "Rep One" },
    };
    expect(normalizePipedriveDeal(raw)).toEqual({
      id: 42,
      title: "Oakland Park CIPP",
      value: 250000,
      currency: "USD",
      status: "open",
      pipeline_id: 3,
      stage_id: 9,
      expected_close_date: "2026-09-10",
      last_activity_date: "2026-07-20",
      next_activity_date: null,
      org_name: "City of Oakland Park",
      person_name: "Jane Roe",
      owner_name: "Rep One",
    });
  });

  it("drops a record with no usable id", () => {
    expect(normalizePipedriveDeal({ title: "no id" })).toBeNull();
  });

  it("is read-only and paginates via injected fetch", async () => {
    const pages = [
      {
        success: true,
        data: [{ id: 1, title: "A", status: "open" }],
        additional_data: { pagination: { more_items_in_collection: true, next_start: 100 } },
      },
      {
        success: true,
        data: [{ id: 2, title: "B", status: "open" }],
        additional_data: { pagination: { more_items_in_collection: false, next_start: null } },
      },
    ];
    const calls: string[] = [];
    let page = 0;
    const fetchImpl = (async (url: URL | string) => {
      calls.push(String(url));
      const body = pages[page++];
      return { ok: true, json: async () => body } as Response;
    }) as unknown as typeof fetch;

    const client = new PipedriveClient({
      apiBase: "https://acme.pipedrive.com",
      apiToken: "secret-token",
      fetchImpl,
    });
    const deals = await client.fetchOpenDeals();
    expect(deals.map((d) => d.id)).toEqual([1, 2]);
    // every request is a GET for open deals; the token rides as a query param
    expect(calls.every((u) => u.includes("/api/v1/deals") && u.includes("status=open"))).toBe(true);
    expect(calls[1]).toContain("start=100");
  });
});
