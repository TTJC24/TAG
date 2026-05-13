// Microsoft Graph client using the MSAL Node client-credentials flow.
// Used by:
//   - Teams chat reminders (Phase 3 — pre-meeting nudges)
//   - Recap messages to entity channels on conclude (Phase 7)
//   - Optional Teams native transcript pull (Phase 6, TranscriptSource(teams_native))
//
// The app is configured in Entra ID with admin consent for:
//   - Chat.ReadWrite
//   - OnlineMeetings.Read.All
//   - OnlineMeetingTranscript.Read.All
//
// Tokens are cached in-process (MSAL handles refresh/expiry under the hood).

import { ConfidentialClientApplication } from "@azure/msal-node";
import { requireEnv } from "@/lib/env";

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

let _client: ConfidentialClientApplication | null = null;
function client(): ConfidentialClientApplication {
  if (_client) return _client;
  const tenant = requireEnv("MICROSOFT_TENANT_ID");
  _client = new ConfidentialClientApplication({
    auth: {
      clientId: requireEnv("MICROSOFT_CLIENT_ID"),
      clientSecret: requireEnv("MICROSOFT_CLIENT_SECRET"),
      authority: `https://login.microsoftonline.com/${tenant}`,
    },
  });
  return _client;
}

export class GraphError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

/** Acquires (and caches) an app-only access token for Microsoft Graph. */
export async function getAccessToken(): Promise<string> {
  const result = await client().acquireTokenByClientCredential({
    scopes: [GRAPH_SCOPE],
  });
  if (!result?.accessToken) {
    throw new GraphError("MSAL returned no access token");
  }
  return result.accessToken;
}

interface GraphRequestInit extends Omit<RequestInit, "headers"> {
  /** Additional headers to merge on top of authorization/content-type. */
  headers?: Record<string, string>;
}

/** Thin Graph REST wrapper. Adds bearer auth + JSON content-type, handles
 *  error bodies, and parses JSON when present. */
export async function graphFetch<T>(
  path: string,
  init: GraphRequestInit = {},
): Promise<T> {
  const token = await getAccessToken();
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GraphError(
      `Graph ${res.status} ${res.statusText}`,
      res.status,
      body,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Post a chat message. Requires the granted `Chat.ReadWrite` app permission.
 *  In Phase 3 the pre-meeting reminder loop will resolve `chatId` for each
 *  attendee (one-on-one chat between the bot and the user). */
export async function postChatMessage(
  chatId: string,
  content: string,
): Promise<{ id: string }> {
  return graphFetch<{ id: string }>(`/chats/${chatId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: { content } }),
  });
}
