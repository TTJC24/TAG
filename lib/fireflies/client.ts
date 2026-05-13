// Fireflies GraphQL client. Phase 1 wires only the bits needed for the
// smoke check and (eventually) transcript retrieval. The full transcript
// path lands in Phase 6 behind the TranscriptSource adapter (ADR-0004).

import { requireEnv } from "@/lib/env";

const FIREFLIES_ENDPOINT = "https://api.fireflies.ai/graphql";

export class FirefliesError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FirefliesError";
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(FIREFLIES_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${requireEnv("FIREFLIES_API_KEY")}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new FirefliesError(
      `Fireflies HTTP ${res.status} ${res.statusText}`,
      res.status,
    );
  }
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    throw new FirefliesError(
      `Fireflies GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!json.data) {
    throw new FirefliesError("Fireflies returned no data");
  }
  return json.data;
}

export interface FirefliesUser {
  user_id: string;
  name: string;
  email: string;
}

/** Verifies the configured API key by fetching the current user's identity.
 *  Read-only — no side effects on the Fireflies workspace. */
export async function getCurrentUser(): Promise<FirefliesUser> {
  const data = await gql<{ user: FirefliesUser }>(
    `query { user { user_id name email } }`,
  );
  return data.user;
}
