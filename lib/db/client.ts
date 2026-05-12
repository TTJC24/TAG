// Postgres client (Neon serverless driver + Drizzle).
//
// The schema lives in lib/db/schema.ts (added in Phase 1 step 2). At this
// step we only export a typed db instance and a helper for one-shot scripts.
//
// In Server Components / Route Handlers, import { db } from "@/lib/db/client".
// Do not pass `db` to the browser.

import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { requireEnv } from "@/lib/env";

// Neon defaults are fine for our use; this is the place to flip
// `fetchConnectionCache` etc. if we ever need to.
neonConfig.fetchConnectionCache = true;

const sql = neon(requireEnv("DATABASE_URL"));

// Schema arg is omitted until step 2 lands schema.ts; we re-export then.
export const db = drizzle(sql);

export type Db = typeof db;
