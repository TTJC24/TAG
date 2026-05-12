// One-off: add a given Clerk user as org:admin to fs, bl, and usa.
//
// Run:  pnpm setup:clerk-admin user_xxxxxxxxxxxxxxxxxxxxxxxx
//
// Idempotent — re-running on an existing membership skips it.
// Used for dev onboarding now; Step 10's seed script will handle the full
// team programmatically.

import { createClerkClient } from "@clerk/backend";

const SECRET = process.env.CLERK_SECRET_KEY;
if (!SECRET) {
  console.error(
    "[clerk-add-admin] CLERK_SECRET_KEY missing. Add it to .env.local and re-run.",
  );
  process.exit(1);
}

const userIdArg = process.argv[2];
if (!userIdArg || !userIdArg.startsWith("user_")) {
  console.error(
    "[clerk-add-admin] usage: pnpm setup:clerk-admin <user_xxxxxxxxxxxx>",
  );
  process.exit(1);
}
const userId: string = userIdArg;

const clerk = createClerkClient({ secretKey: SECRET });

const TARGET_SLUGS = ["fs", "bl", "usa"] as const;
const ROLE = "org:admin";

async function main() {
  const orgs = await clerk.organizations.getOrganizationList({ limit: 200 });
  const bySlug = new Map(orgs.data.map((o) => [o.slug, o]));

  for (const slug of TARGET_SLUGS) {
    const org = bySlug.get(slug);
    if (!org) {
      console.log(`[clerk-add-admin] ${slug.padEnd(4)} MISSING — run setup:clerk first`);
      continue;
    }

    // Check existing memberships for this org and skip if the user is already in.
    const existing = await clerk.organizations.getOrganizationMembershipList({
      organizationId: org.id,
      limit: 200,
    });
    const already = existing.data.find((m) => m.publicUserData?.userId === userId);
    if (already) {
      console.log(
        `[clerk-add-admin] ${slug.padEnd(4)} already member role=${already.role} id=${org.id}`,
      );
      continue;
    }

    try {
      await clerk.organizations.createOrganizationMembership({
        organizationId: org.id,
        userId,
        role: ROLE,
      });
      console.log(`[clerk-add-admin] ${slug.padEnd(4)} added as ${ROLE} id=${org.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[clerk-add-admin] ${slug.padEnd(4)} FAILED — ${msg}`);
    }
  }
}

main().catch((err) => {
  console.error("[clerk-add-admin] fatal:", err);
  process.exit(1);
});
