import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getOrgMembers } from "@/lib/queries/org-members";
import { getOrgRocks } from "@/lib/queries/org-lists";
import {
  AddRockButton,
  RocksTable,
  RockStatusSummary,
  type RockRow,
} from "@/components/rock-dialogs";
import { CommandStrip, Panel } from "@/components/ui/primitives";

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

  // Map server-fetched rows to a serializable, presentation-ready shape.
  // Sort + ordering are preserved exactly from getOrgRocks (off_track first).
  const tableRows: RockRow[] = rows.map(({ rock, owner }) => {
    const isOwner = rock.ownerId === ctx.personId;
    const readOnly =
      ctx.role === "viewer" || (ctx.role === "member" && !isOwner);
    return {
      id: rock.id,
      description: rock.description,
      status: rock.status,
      ownerName: owner?.name ?? null,
      quarter: rock.quarter,
      dueDate: rock.dueDate ?? null,
      notes: rock.notes ?? null,
      readOnly,
      current: {
        description: rock.description,
        ownerId: rock.ownerId,
        quarter: rock.quarter,
        dueDate: rock.dueDate ?? "",
        notes: rock.notes ?? "",
      },
    };
  });

  return (
    <main className="container space-y-5 py-6">
      <CommandStrip
        eyebrow={`${ctx.orgName} · EOS`}
        title="Rocks"
        right={
          <>
            <RockStatusSummary rows={tableRows} />
            {isAdmin && <AddRockButton members={members} />}
          </>
        }
      />

      {tableRows.length === 0 ? (
        <Panel>
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            No rocks for this org yet.
          </p>
        </Panel>
      ) : (
        <Panel>
          <RocksTable rows={tableRows} members={members} canDelete={isAdmin} />
        </Panel>
      )}
    </main>
  );
}
