// One-shot Clerk Organizations bootstrap. Idempotent.
//
// Run: pnpm setup:clerk
//
// Checks the workspace for orgs with slugs `fs`, `bl`, `usa`. Creates any
// that are missing. Prints a short report (org IDs are public identifiers,
// safe to surface). Does not touch users or memberships — that's the seed
// script in Step 10.

import { createClerkClient } from "@clerk/backend";

const SECRET = process.env.CLERK_SECRET_KEY;
if (!SECRET) {
  console.error(
    "[clerk-setup] CLERK_SECRET_KEY is missing. Add it to .env.local and re-run.",
  );
  process.exit(1);
}

const clerk = createClerkClient({ secretKey: SECRET });

const SEED_ORGS = [
  { name: "Fastening Specialists", slug: "fs" },
  { name: "Big League Construction Supply", slug: "bl" },
  { name: "Utility Supply Associates", slug: "usa" },
] as const;

async function main() {
  // Page through the workspace once. With 3 target orgs (and small overall),
  // a single 200-row page is enough; expand the loop later if we grow.
  const existing = await clerk.organizations.getOrganizationList({
    limit: 200,
  });
  const bySlug = new Map(existing.data.map((o) => [o.slug, o]));

  for (const target of SEED_ORGS) {
    const found = bySlug.get(target.slug);
    if (found) {
      console.log(
        `[clerk-setup] ${target.slug.padEnd(4)} exists  id=${found.id}`,
      );
      continue;
    }
    const created = await clerk.organizations.createOrganization({
      name: target.name,
      slug: target.slug,
    });
    console.log(
      `[clerk-setup] ${(created.slug ?? target.slug).padEnd(4)} created id=${created.id}`,
    );
  }
}

main().catch((err) => {
  console.error("[clerk-setup] failed:", err);
  process.exit(1);
});
