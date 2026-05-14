// One-shot cleanup: delete stray Clerk orgs that are not linked to any
// local `organizations` row. Conservative — never touches an org whose
// id matches a row in the local table.

import { createClerkClient } from "@clerk/backend";
import { db } from "@/lib/db/client";
import { organizations } from "@/lib/db/schema";

async function main() {
  const local = await db.select().from(organizations);
  const canonicalClerkIds = new Set(local.map((r) => r.clerkOrgId));
  console.log("Canonical Clerk org ids:");
  for (const r of local) console.log(`  ${r.clerkOrgId}  ${r.name}`);

  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const list = await clerk.organizations.getOrganizationList({ limit: 200 });
  console.log("");
  console.log("All Clerk orgs:");
  for (const o of list.data) {
    const canonical = canonicalClerkIds.has(o.id);
    console.log(
      `  ${canonical ? "KEEP " : "STRAY"}  ${o.id}  slug=${o.slug}  name="${o.name}"`,
    );
  }

  console.log("");
  console.log("Deleting strays …");
  let deleted = 0;
  for (const o of list.data) {
    if (canonicalClerkIds.has(o.id)) continue;
    try {
      await clerk.organizations.deleteOrganization(o.id);
      console.log(`  deleted ${o.id} (${o.name})`);
      deleted++;
    } catch (err) {
      console.warn(
        `  FAILED to delete ${o.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  console.log(`Done. ${deleted} stray Clerk org(s) deleted.`);
}
main();
