// Server-side Liveblocks broadcaster. Server actions call this after a
// successful DB write so other clients viewing the same room re-fetch.
//
// Broadcast-event-and-refetch (rather than mirroring state into Liveblocks
// Storage) keeps Postgres as the single source of truth (ADR-0005). Clients
// listen for these events and call router.refresh() / revalidate.

import { Liveblocks } from "@liveblocks/node";
import { optionalEnv } from "@/lib/env";
import { ROOM } from "@/liveblocks.config";

let _client: Liveblocks | null = null;
function client(): Liveblocks | null {
  if (_client) return _client;
  const secret = optionalEnv("LIVEBLOCKS_SECRET_KEY");
  if (!secret) return null;
  _client = new Liveblocks({ secret });
  return _client;
}

/** Mirrors the ambient `Liveblocks.RoomEvent` shape declared in
 *  liveblocks.config.ts. Re-declared (rather than re-imported) so callers
 *  can import the union without pulling the global ambient declaration. */
export type RoomEvent =
  | {
      kind: "entry-updated";
      entryId: string;
      measurableId: string;
      weekId: string;
    }
  | { kind: "rock-updated"; rockId: string }
  | { kind: "todo-updated"; todoId: string }
  | { kind: "issue-updated"; issueId: string };

/** Broadcasts a room event. No-ops if Liveblocks isn't configured — the DB
 *  is still the source of truth and the actor's own UI re-renders via
 *  revalidatePath, so absence of Liveblocks degrades to "no live updates
 *  for other tabs" rather than breakage. */
export async function broadcastScorecard(
  orgId: string,
  event: RoomEvent,
): Promise<void> {
  const lb = client();
  if (!lb) return;
  try {
    await lb.broadcastEvent(ROOM.scorecard(orgId), event);
  } catch (err) {
    // Best-effort. A failed broadcast must not abort the underlying write.
    console.warn("[broadcast] scorecard broadcast failed:", err);
  }
}
