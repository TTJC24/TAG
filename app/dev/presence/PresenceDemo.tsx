"use client";

import { useMyPresence, useOthers, useSelf } from "@liveblocks/react/suspense";
import { useEffect } from "react";

export function PresenceDemo() {
  const self = useSelf();
  const others = useOthers();
  const [_myPresence, updateMyPresence] = useMyPresence();

  // Broadcast cursor position on mousemove.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      updateMyPresence({
        cursor: {
          x: e.clientX / window.innerWidth,
          y: e.clientY / window.innerHeight,
        },
      });
    }
    function onLeave() {
      updateMyPresence({ cursor: null });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [updateMyPresence]);

  return (
    <div className="space-y-6">
      <section className="rounded border border-border bg-card p-4">
        <p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">
          you
        </p>
        <div className="flex items-center gap-3">
          <Avatar name={self.info.name} src={self.info.avatarUrl} />
          <div className="font-mono text-sm tabular">
            <div>{self.info.name}</div>
            <div className="text-xs text-muted-foreground">
              {self.info.orgSlug}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded border border-border bg-card p-4">
        <p className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">
          others in this room ({others.length})
        </p>
        {others.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Open this page in a second tab (or invite another teammate) to see
            their avatar appear here.
          </p>
        ) : (
          <ul className="space-y-2">
            {others.map((o) => (
              <li key={o.connectionId} className="flex items-center gap-3">
                <Avatar name={o.info.name} src={o.info.avatarUrl} />
                <div className="font-mono text-sm tabular">
                  <div>{o.info.name}</div>
                  <div className="text-xs text-muted-foreground">
                    cursor:{" "}
                    {o.presence.cursor
                      ? `${(o.presence.cursor.x * 100).toFixed(0)}%, ${(o.presence.cursor.y * 100).toFixed(0)}%`
                      : "off-canvas"}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Floating cursors from other users. */}
      {others
        .filter((o) => o.presence.cursor !== null)
        .map((o) => (
          <div
            key={o.connectionId}
            className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded bg-primary px-1.5 py-0.5 font-mono text-[10px] text-primary-foreground"
            style={{
              left: `${(o.presence.cursor!.x * 100).toFixed(2)}%`,
              top: `${(o.presence.cursor!.y * 100).toFixed(2)}%`,
            }}
          >
            {o.info.name}
          </div>
        ))}
    </div>
  );
}

function Avatar({ name, src }: { name: string; src?: string }) {
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        alt={name}
        src={src}
        className="h-8 w-8 rounded-full border border-border"
      />
    );
  }
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-muted font-mono text-xs">
      {initials || "?"}
    </span>
  );
}
