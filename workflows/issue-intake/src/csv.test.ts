import { describe, expect, it } from "vitest";
import { parseCsvIssueBatch } from "./csv.js";

const organizationId = "10000000-0000-4000-8000-000000000001";

function input(content: string) {
  return {
    organizationId,
    fileName: "issues.csv",
    content,
    sourceTimestamp: "2026-07-25T12:00:00.000Z",
    schemaVersion: "csv-issue.v1" as const,
    retentionClassification: "operational" as const,
  };
}

describe("controlled CSV issue parser", () => {
  it("parses quoted commas, escaped quotes, and newlines deterministically", () => {
    const parsed = parseCsvIssueBatch(
      input(
        [
          "title,description,task_type,due_date",
          '"Vendor, Inc. delay","Promised ""Friday"",',
          'now Monday",procurement,2026-07-28',
        ].join("\n"),
      ),
    );

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      rowNumber: 2,
      rejectionReasons: [],
      normalizedInput: {
        organizationId,
        title: "Vendor, Inc. delay",
        description: 'Promised "Friday",\nnow Monday',
        taskType: "procurement",
        dueDate: "2026-07-28",
        retentionClassification: "operational",
      },
    });
  });

  it("keeps valid rows while rejecting malformed and schema-invalid rows", () => {
    const parsed = parseCsvIssueBatch(
      input(
        [
          "title,description,financial_exposure,financial_exposure_currency",
          "Valid issue,Needs follow-up,1250,USD",
          "Missing description,,250,USD",
          "Bad amount,Needs review,not-money,USD",
          "Wrong width,Only two columns",
        ].join("\r\n"),
      ),
    );

    expect(parsed.rows.map((row) => row.normalizedInput !== null)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(parsed.rows[0]?.normalizedInput).toMatchObject({
      financialExposure: 1250,
      financialExposureCurrency: "USD",
    });
    expect(parsed.rows[1]?.rejectionReasons.join(" ")).toContain("description");
    expect(parsed.rows[2]?.rejectionReasons.join(" ")).toContain(
      "financialExposure",
    );
    expect(parsed.rows[3]?.rejectionReasons).toContain(
      "Expected 4 columns but received 2",
    );
  });

  it("rejects an unsupported file contract before any row can be accepted", () => {
    expect(() =>
      parseCsvIssueBatch(input("title,description,customer\nA,B,C")),
    ).toThrow("Unsupported CSV headers: customer");
  });
});
