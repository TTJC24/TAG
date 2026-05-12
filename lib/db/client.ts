// Postgres client (Neon serverless driver + Drizzle), wired to the schema.
//
// Server-side only — do not import from a client component.

import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { requireEnv } from "@/lib/env";
import * as schema from "@/lib/db/schema";

neonConfig.fetchConnectionCache = true;

const sql = neon(requireEnv("DATABASE_URL"));

export const db = drizzle(sql, { schema });

export { schema };
export type Db = typeof db;
