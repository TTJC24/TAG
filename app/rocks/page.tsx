import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getOrgMembers } from "@/lib/queries/org-members";
import { getOrgRocks } from "@/lib/queries/org-lists";
import { AddRockButton, RockRowControls } from "@/components/rock-dialogs";
import { RockStatusSelect } from "@/components/rock-status-select";
import { RockNotesEditor } from "@/components/rock-notes-editor";
import { OwnerChip } from "@/components/ui/primitives";
import { SurfaceBlock, type BlockStatus } from "@/components/ui/surface-block";
import { SurfaceHeader, StatNumber } from "@/components/ui/surface-header";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type RockStatus = "on_track" | "off_track" | "still_going" | "completed";

const BLOCK_STATUS: Record<RockStatus, BlockStatus> = {
  off_track: "red",
  on_track: "green",
  still_going: "yellow",
  completed: "muted",
};

function isOverdue(dueDate: string | null, status: RockStatus): boolean {
  if (!dueDate || status === "completed") return false;
  return dueDate < new Date().toISOString().slice(0, 10);
}

export default async function RocksPage() {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch (err) {
    if (err instanceof AuthContextError && err.reason === "no_active_org") {
      redirect("/");
    }
    throw err;
  }

  const [rows, members] = await Promise.all([
    getOrgRocks(ctx.orgId),
    getOrgMembers(ctx.orgId),
  ]);
  const isAdmin = ctx.role === "admin";

  const counts = rows.reduce(
    (acc, { rock }) => {
      acc[rock.status] += 1;
      return acc;
    },
    { off_track: 0, on_track: 0, still_going: 0, completed: 0 } as Record<
      RockStatus,
      number
    >,
  );

  return (
    <main className="container space-y-7 py-7">
      <SurfaceHeader
        eyebrow={`${ctx.orgName} · quarterly priorities`}
        title="Rocks"
      >
        <StatNumber value={counts.off_track} label="off track" tone="red" hero />
        <StatNumber value={counts.on_track} label="on track" tone="green" />
        <StatNumber value={counts.still_going} label="still going" tone="yellow" />
        <StatNumber value={counts.completed} label="done" tone="muted" />
        {isAdmin && (
          <div className="self-center pl-1">
            <AddRockButton members={members} />
          </div>
        )}
      </SurfaceHeader>

      {rows.length === 0 ? (
        <p className="rounded-[2px] border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
          No rocks for this org yet.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(({ rock, owner }) => {
            const status = rock.status as RockStatus;
            const isOwner = rock.ownerId === ctx.personId;
            const readOnly =
              ctx.role === "viewer" || (ctx.role === "member" && !isOwner);
            const done = status === "completed";
            const overdue = isOverdue(rock.dueDate ?? null, status);
            return (
              <SurfaceBlock
                key={rock.id}
                status={BLOCK_STATUS[status]}
                className={cn("min-h-[12rem]", done && "opacity-70")}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="eyebrow truncate pt-0.5">{rock.quarter}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <OwnerChip name={owner?.name ?? null} />
                    <RockRowControls
                      rockId={rock.id}
                      members={members}
                      current={{
                        description: rock.description,
                        ownerId: rock.ownerId,
                        quarter: rock.quarter,
                        dueDate: rock.dueDate ?? "",
                        notes: rock.notes ?? "",
                      }}
                      readOnly={readOnly}
                      canDelete={isAdmin}
                    />
                  </div>
                </div>

                <p
                  className={cn(
                    "mt-3 text-lg font-medium leading-snug tracking-tight text-foreground",
                    done && "text-muted-foreground line-through",
                  )}
                >
                  {rock.description}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <RockStatusSelect
                    rockId={rock.id}
                    status={status}
                    readOnly={readOnly}
                  />
                  <span
                    className={cn(
                      "font-mono text-[11px] uppercase tracking-[0.14em]",
                      overdue ? "text-status-red" : "text-muted-foreground",
                    )}
                  >
                    {rock.dueDate ? `due ${rock.dueDate}` : "no due date"}
                  </span>
                </div>

                <div className="flex-1" />

                <div className="mt-3 border-t border-border/50 pt-3">
                  <RockNotesEditor
                    rockId={rock.id}
                    value={rock.notes ?? null}
                    readOnly={readOnly}
                  />
                </div>
              </SurfaceBlock>
            );
          })}
        </div>
      )}
    </main>
  );
}
