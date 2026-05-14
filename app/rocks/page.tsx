import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getOrgMembers } from "@/lib/queries/org-members";
import { getOrgRocks } from "@/lib/queries/org-lists";
import { AddRockButton, RockRowControls } from "@/components/rock-dialogs";
import { RockNotesEditor } from "@/components/rock-notes-editor";
import { RockStatusSelect } from "@/components/rock-status-select";
import {
  Eyebrow,
  OwnerChip,
  Panel,
  PanelHeader,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

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
    (acc, r) => {
      acc[r.rock.status] += 1;
      return acc;
    },
    { on_track: 0, off_track: 0, still_going: 0, completed: 0 },
  );

  return (
    <main className="container space-y-5 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Eyebrow>{ctx.orgName} · Rocks</Eyebrow>
          <h1 className="text-xl font-semibold tracking-tight">
            Quarterly priorities
          </h1>
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <Pill tone="red" label={`${counts.off_track} off`} />
          <Pill tone="green" label={`${counts.on_track} on`} />
          <Pill tone="amber" label={`${counts.still_going} still going`} />
          <Pill tone="muted" label={`${counts.completed} done`} />
          {isAdmin && <AddRockButton members={members} />}
        </div>
      </header>

      {rows.length === 0 ? (
        <Panel>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No rocks for this org.
          </p>
        </Panel>
      ) : (
        <Panel>
          <PanelHeader title="Rock" count={rows.length} hint="off-track first" />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <Th className="pl-4">Rock</Th>
                  <Th>Owner</Th>
                  <Th>Status</Th>
                  <Th>Notes</Th>
                  <Th className="tabular">Quarter · Due</Th>
                  <Th className="pr-4"> </Th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ rock, owner }) => {
                  const isOwner = rock.ownerId === ctx.personId;
                  const readOnly =
                    ctx.role === "viewer" || (ctx.role === "member" && !isOwner);
                  return (
                    <tr
                      key={rock.id}
                      className="border-t border-border/70 align-top"
                    >
                      <Td className="pl-4 font-medium">{rock.description}</Td>
                      <Td>
                        <OwnerChip name={owner?.name ?? null} />
                      </Td>
                      <Td>
                        <RockStatusSelect
                          rockId={rock.id}
                          status={rock.status}
                          readOnly={readOnly}
                        />
                      </Td>
                      <Td className="min-w-[18rem]">
                        <RockNotesEditor
                          rockId={rock.id}
                          value={rock.notes}
                          readOnly={readOnly}
                        />
                      </Td>
                      <Td className="font-mono text-xs text-muted-foreground tabular">
                        {rock.quarter}
                        {rock.dueDate ? ` · ${rock.dueDate}` : ""}
                      </Td>
                      <Td className="pr-4 text-right">
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
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </main>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "border-b border-border/70 bg-card/40 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("px-3 py-2 text-sm", className)}>{children}</td>;
}

function Pill({
  tone,
  label,
}: {
  tone: "red" | "green" | "amber" | "muted";
  label: string;
}) {
  const dot =
    tone === "red"
      ? "bg-rose-400"
      : tone === "green"
        ? "bg-emerald-400"
        : tone === "amber"
          ? "bg-amber-400"
          : "bg-muted-foreground/40";
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}
