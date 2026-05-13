"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  LiveblocksProvider,
  RoomProvider,
  useEventListener,
} from "@liveblocks/react/suspense";
import "@/liveblocks.config";
import { ROOM } from "@/liveblocks.config";

interface LiveSyncProps {
  /** Clerk org id — keys the scorecard room. */
  clerkOrgId: string;
}

/** Subscribes the current page to scorecard:{clerkOrgId} broadcasts and
 *  triggers router.refresh() on every event. Cheap: the broadcaster only
 *  fires after a real DB write, and refresh() reuses the cached fetch unless
 *  it was invalidated.
 *
 *  Mount once per page that wants live updates. Renders nothing. */
export function LiveSync({ clerkOrgId }: LiveSyncProps) {
  return (
    <LiveblocksProvider authEndpoint="/api/liveblocks-auth">
      <RoomProvider
        id={ROOM.scorecard(clerkOrgId)}
        initialPresence={{ cursor: null, editingCell: null }}
      >
        <LiveSyncInner />
      </RoomProvider>
    </LiveblocksProvider>
  );
}

function LiveSyncInner() {
  const router = useRouter();
  useEventListener(() => {
    router.refresh();
  });
  // We also re-render on reconnect — covers the case where a Liveblocks
  // outage happens mid-meeting and we want a fresh fetch on reconnect.
  useEffect(() => {
    return () => undefined;
  }, []);
  return null;
}
