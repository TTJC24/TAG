// Liveblocks type configuration. v2+ uses ambient `Liveblocks` interface
// declarations so all hooks pick up the right shapes globally.
//
// Room ID conventions (per CLAUDE.md):
//   - scorecard:{orgId}        — permanent room per org's scorecard
//   - meeting:{meetingId}      — ephemeral room per live meeting (Phase 4+)
//
// Server is the source of truth (Postgres). Liveblocks is the coordination
// layer; the static snapshot lands in week_snapshots / meetings rows on
// conclude (ADR-0005).

declare global {
  interface Liveblocks {
    Presence: {
      /** Cursor position in normalized 0..1 viewport coords; null when off-canvas. */
      cursor: { x: number; y: number } | null;
      /** ID of the cell currently being edited, for live cell-edit indicators. */
      editingCell: string | null;
    };
    /** Shared room storage. Empty for v1 — Postgres is the source of truth and
     *  Liveblocks broadcasts canonical writes via the server action pipeline. */
    Storage: Record<string, never>;
    /** Identity payload returned by /api/liveblocks-auth. */
    UserMeta: {
      id: string;
      info: {
        name: string;
        email: string;
        avatarUrl?: string;
        orgSlug: string;
      };
    };
    /** Server-broadcast events fired by lib/realtime/broadcast.ts after a
     *  successful write. Clients listen and call router.refresh() so other
     *  tabs reflect the change without polling. */
    RoomEvent:
      | {
          kind: "entry-updated";
          entryId: string;
          measurableId: string;
          weekId: string;
        }
      | { kind: "rock-updated"; rockId: string }
      | { kind: "todo-updated"; todoId: string }
      | { kind: "issue-updated"; issueId: string };
    /** Room metadata accessible via useRoomInfo. */
    RoomInfo: { orgId: string };
  }
}

export const ROOM = {
  scorecard: (orgId: string) => `scorecard:${orgId}`,
  meeting: (meetingId: string) => `meeting:${meetingId}`,
} as const;
