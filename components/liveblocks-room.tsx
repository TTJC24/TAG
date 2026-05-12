"use client";

import {
  LiveblocksProvider,
  RoomProvider,
  ClientSideSuspense,
} from "@liveblocks/react/suspense";
import type { ReactNode } from "react";
import "@/liveblocks.config";

interface LiveblocksRoomProps {
  roomId: string;
  fallback?: ReactNode;
  children: ReactNode;
}

/** Wraps a subtree in LiveblocksProvider + RoomProvider with sensible
 *  defaults. Pass `roomId` like `scorecard:${orgId}` or
 *  `meeting:${meetingId}`. */
export function LiveblocksRoom({
  roomId,
  fallback,
  children,
}: LiveblocksRoomProps) {
  return (
    <LiveblocksProvider authEndpoint="/api/liveblocks-auth">
      <RoomProvider
        id={roomId}
        initialPresence={{ cursor: null, editingCell: null }}
      >
        <ClientSideSuspense fallback={fallback ?? null}>
          {children}
        </ClientSideSuspense>
      </RoomProvider>
    </LiveblocksProvider>
  );
}
