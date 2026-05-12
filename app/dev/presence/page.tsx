import { auth } from "@clerk/nextjs/server";
import { LiveblocksRoom } from "@/components/liveblocks-room";
import { ROOM } from "@/liveblocks.config";
import { PresenceDemo } from "./PresenceDemo";

export default async function PresenceDevPage() {
  const { orgId, orgSlug } = await auth();

  if (!orgId) {
    return (
      <main className="container flex min-h-screen flex-col gap-6 py-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">/dev/presence</h1>
          <p className="text-sm text-muted-foreground">
            Pick an organization in the switcher to join its scorecard room.
          </p>
        </header>
      </main>
    );
  }

  const roomId = ROOM.scorecard(orgId);

  return (
    <main className="container flex min-h-screen flex-col gap-6 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">/dev/presence</h1>
        <p className="text-sm text-muted-foreground">
          Liveblocks presence demo. Move your mouse — open this page in a
          second tab or device to see other cursors and avatars.
        </p>
        <p className="font-mono text-xs text-muted-foreground tabular">
          room: {roomId} · org: {orgSlug ?? orgId}
        </p>
      </header>
      <LiveblocksRoom
        roomId={roomId}
        fallback={
          <p className="text-sm text-muted-foreground">connecting…</p>
        }
      >
        <PresenceDemo />
      </LiveblocksRoom>
    </main>
  );
}
