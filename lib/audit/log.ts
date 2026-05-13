// Audit-log writer. Every persistence call goes through here before
// returning to the caller. See docs/permissions.md §"The write contract".

import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";

export type AuditSource =
  | "manual"
  | "voice"
  | "fireflies"
  | "teams_native"
  | "transcript_manual"
  | "system";

export interface AuditEntry {
  orgId: string;
  /** Who is acting (the logged-in user, or null for system writes). */
  personId: string | null;
  /** Verb, e.g. update_actual, complete_todo, resolve_issue. */
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  source: AuditSource;
  /** Set when source-side diarization (Fireflies, Teams native) attributed
   *  the change to someone other than the acting user. */
  attributedToPersonId?: string | null;
}

export async function writeAuditEntry(entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    orgId: entry.orgId,
    personId: entry.personId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    source: entry.source,
    attributedToPersonId: entry.attributedToPersonId ?? null,
  });
}
