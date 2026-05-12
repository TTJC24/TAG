// One-shot migrator. Run with `pnpm db:migrate`.
//
// Uses the Neon HTTP driver so we stay on a single Postgres driver across
// runtime and migrations. drizzle-kit `migrate` can do this too — keeping
// a script lets us add seed-state checks or post-migration hooks later
// without touching CI config.

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import { requireEnv } from "@/lib/env";

async function run() {
  const sql = neon(requireEnv("DATABASE_URL"));
  const db = drizzle(sql);
  console.log("[db:migrate] running migrations from ./drizzle …");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("[db:migrate] done.");
}

run().catch((err) => {
  console.error("[db:migrate] failed:", err);
  process.exit(1);
});
