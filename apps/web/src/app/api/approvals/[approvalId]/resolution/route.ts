import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { identityHeaders } from "../../../../../lib/identity";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:3001";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ approvalId: string }> },
) {
  const { approvalId } = await params;
  const response = await fetch(
    `${apiBaseUrl}/v1/approvals/${encodeURIComponent(approvalId)}/resolution`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key":
          request.headers.get("idempotency-key") ?? randomUUID(),
        ...(await identityHeaders()),
        "x-trace-id": request.headers.get("x-trace-id") ?? randomUUID(),
      },
      body: await request.text(),
    },
  );
  return new NextResponse(await response.text(), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}
