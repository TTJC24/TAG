import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getOrgRocks } from "@/lib/queries/org-lists";
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

  const rows = await getOrgRocks(ctx.orgId);

  const counts = rows.reduce(
    (acc, r) => {
      acc[r.rock.status] += 1;
      return acc;
    },
    { on_track: 0, off_track: 0, completed: 0 },
  );

  return (
    <main className="container space-y-6 py-8">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          {ctx.orgSlug.toUpperCase()} · Rocks
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Quarterly rocks
        </h1>
        <p className="text-sm text-muted-foreground">
          Off-track first. Active org only.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-4 rounded border border-border bg-card px-4 py-3 text-sm">
        <Pill color="red" label={`${counts.off_track} off track`} />
        <Pill color="green" label={`${counts.on_track} on track`} />
        <Pill color="muted" label={`${counts.completed} done`} />
      </div>

      {rows.length === 0 ? (
        <p className="rounded border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          No rocks for this org.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2 font-medium">Rock</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Notes</th>
                <th className="px-3 py-2 font-medium tabular">Due</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ rock, owner }) => (
                <tr key={rock.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 font-medium">{rock.description}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {owner?.name ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <StatusChip status={rock.status} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {rock.notes ?? ""}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground tabular">
                    {rock.dueDate ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

const DOT_STYLES: Record<"red" | "green" | "muted", string> = {
  red: "bg-rose-400",
  green: "bg-emerald-400",
  muted: "bg-muted-foreground/40",
};

function Pill({
  color,
  label,
}: {
  color: "red" | "green" | "muted";
  label: string;
}) {
  return (
    <span className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
      <span className={cn("h-2 w-2 rounded-full", DOT_STYLES[color])} aria-hidden />
      {label}
    </span>
  );
}

const STATUS_LABEL: Record<"on_track" | "off_track" | "completed", string> = {
  on_track: "on track",
  off_track: "off track",
  completed: "done",
};

const STATUS_TAG_STYLES: Record<
  "on_track" | "off_track" | "completed",
  string
> = {
  on_track: "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
  off_track: "border-rose-500/30 bg-rose-500/10 text-rose-100",
  completed: "border-border bg-muted/30 text-muted-foreground",
};

function StatusChip({
  status,
}: {
  status: "on_track" | "off_track" | "completed";
}) {
  return (
    <span
      className={cn(
        "rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
        STATUS_TAG_STYLES[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
