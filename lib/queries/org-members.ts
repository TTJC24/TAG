// Lightweight org-members lookup for the owner picker. Returns the
// minimum needed: id + name. Sorted alphabetical.

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orgMemberships, people } from "@/lib/db/schema";

export interface OrgMemberOption {
  id: string;
  name: string;
}

export async function getOrgMembers(orgId: string): Promise<OrgMemberOption[]> {
  return db
    .select({ id: people.id, name: people.name })
    .from(orgMemberships)
    .innerJoin(people, eq(orgMemberships.personId, people.id))
    .where(eq(orgMemberships.orgId, orgId))
    .orderBy(asc(people.name));
}
