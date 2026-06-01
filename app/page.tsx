import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { people } from "@/lib/db/schema";
import {
  getEntityHealth,
  getUserEntities,
  type EntityHealth,
} from "@/lib/queries/dashboard";
import { EntityBand } from "@/components/entity-band";
import { SurfaceHeader, StatNumber } from "@/components/ui/surface-header";
import { Eyebrow } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

/** The landing dashboard — every entity the operator belongs to, at a glance.
 *  Cross-entity read scoped to the user's memberships (see lib/queries/
 *  dashboard.ts). Single-org users simply see their one entity. */
export default async function HomePage() {
  const { userId, orgId: activeClerkOrgId } = await auth();

  if (!userId) {
    return <PickOrg />;
  }

  const [person] = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.clerkUserId, userId))
    .limit(1);

  if (!person) {
    return <PickOrg />;
  }

  const entities = await getUserEntities(person.id);
  if (entities.length === 0) {
    return <PickOrg />;
  }

  const healths = await Promise.all(
    entities.map((e) => getEntityHealth(e.orgId)),
  );

  const roll = healths.reduce(
    (acc, h) => {
      acc.onTrack += h.onTrack;
      acc.total += h.total;
      if (h.signal === "red") acc.critical += 1;
      return acc;
    },
    { onTrack: 0, total: 0, critical: 0 },
  );

  return (
    <main className="container space-y-7 py-7">
      <SurfaceHeader
        eyebrow="operations · all entities"
        title="Command"
        sub="cross-entity health · click an entity to drill in"
      >
        <StatNumber value={`${roll.onTrack}/${roll.total}`} label="KPIs on track" hero />
        <StatNumber
          value={roll.critical}
          label="entities critical"
          tone={roll.critical > 0 ? "red" : "muted"}
        />
        <StatNumber value={entities.length} label="entities" tone="muted" />
      </SurfaceHeader>

      <div className="space-y-4">
        {entities.map((e, i) => (
          <EntityBand
            key={e.orgId}
            name={e.name}
            code={e.code}
            role={e.role}
            clerkOrgId={e.clerkOrgId}
            isActive={e.clerkOrgId === activeClerkOrgId}
            health={healths[i] as EntityHealth}
          />
        ))}
      </div>
    </main>
  );
}

function PickOrg() {
  return (
    <main className="flex min-h-[calc(100vh-3rem)] items-center justify-center px-6 py-16">
      <section className="w-full max-w-md rounded-[2px] border border-border bg-surface-1 px-8 py-10 text-center">
        <span className="font-display text-3xl uppercase tracking-[0.02em] text-foreground">
          TractionOS
        </span>
        <Eyebrow className="mt-6">select an organization</Eyebrow>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Use the organization switcher in the top bar to pick a workspace.
          Your entities load as soon as an active org is selected.
        </p>
      </section>
    </main>
  );
}
