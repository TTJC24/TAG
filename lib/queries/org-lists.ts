// Org-wide flat lists for the top-nav tabs (Rocks / To-Do's / Issues).
// Strictly org-scoped — no cross-org reads. Each query is a single
// join with `people` to surface the owner name inline.

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  issues,
  people,
  rocks,
  todos,
  type Issue,
  type Person,
  type Rock,
  type Todo,
} from "@/lib/db/schema";

export interface RockWithOwner {
  rock: Rock;
  owner: Pick<Person, "id" | "name"> | null;
}

export interface TodoWithOwner {
  todo: Todo;
  owner: Pick<Person, "id" | "name"> | null;
}

export interface IssueWithOwner {
  issue: Issue;
  owner: Pick<Person, "id" | "name"> | null;
}

/** All rocks for the org. Active states first (on_track, off_track),
 *  completed last. Within each band sorted by due date. */
export async function getOrgRocks(orgId: string): Promise<RockWithOwner[]> {
  const rows = await db
    .select({ rock: rocks, owner: { id: people.id, name: people.name } })
    .from(rocks)
    .leftJoin(people, eq(rocks.ownerId, people.id))
    .where(eq(rocks.orgId, orgId))
    .orderBy(asc(rocks.dueDate));
  const STATUS_ORDER: Record<Rock["status"], number> = {
    off_track: 0,
    on_track: 1,
    still_going: 2,
    completed: 3,
  };
  return rows
    .map((r) => ({
      rock: r.rock,
      owner: r.owner?.id ? r.owner : null,
    }))
    .sort((a, b) => {
      const oa = STATUS_ORDER[a.rock.status];
      const ob = STATUS_ORDER[b.rock.status];
      if (oa !== ob) return oa - ob;
      return (a.rock.dueDate ?? "").localeCompare(b.rock.dueDate ?? "");
    });
}

/** Open + rolled-over to-dos for the org. Done/dropped are excluded.
 *  Sorted by due date (nulls last), then rollover count desc. */
export async function getOrgTodos(orgId: string): Promise<TodoWithOwner[]> {
  const rows = await db
    .select({ todo: todos, owner: { id: people.id, name: people.name } })
    .from(todos)
    .leftJoin(people, eq(todos.ownerId, people.id))
    .where(
      and(
        eq(todos.orgId, orgId),
        inArray(todos.status, ["open", "rolled_over"]),
      ),
    )
    .orderBy(asc(todos.dueDate), desc(todos.rolloverCount));
  return rows.map((r) => ({
    todo: r.todo,
    owner: r.owner?.id ? r.owner : null,
  }));
}

/** Open + IDS-in-progress issues for the org. Sorted by priority then age. */
export async function getOrgIssues(orgId: string): Promise<IssueWithOwner[]> {
  const rows = await db
    .select({ issue: issues, owner: { id: people.id, name: people.name } })
    .from(issues)
    .leftJoin(people, eq(issues.ownerId, people.id))
    .where(
      and(
        eq(issues.orgId, orgId),
        inArray(issues.status, ["open", "ids_in_progress"]),
      ),
    )
    .orderBy(asc(issues.createdAt));
  const PRIORITY_ORDER: Record<Issue["priority"], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  return rows
    .map((r) => ({
      issue: r.issue,
      owner: r.owner?.id ? r.owner : null,
    }))
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.issue.priority];
      const pb = PRIORITY_ORDER[b.issue.priority];
      if (pa !== pb) return pa - pb;
      return a.issue.createdAt.getTime() - b.issue.createdAt.getTime();
    });
}
