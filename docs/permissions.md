# Permissions

Multi-tenant scoping is via Clerk Organizations. There are exactly three orgs — **FS, BL, USA** — and they are fully independent. No parent org. No combined meetings. No cross-org reads or writes (ADR-0009).

Tim is a member of all three orgs with `admin` role in each — three separate Clerk memberships, configured in the seed script. Everyone else is a member of exactly one org. Clerk's built-in org switcher (top-right) handles toggling for Tim; for single-org users the switcher does not render.

Roles are stored on `people.role` per-org: `admin | member | viewer`. The same human can hold different roles in different orgs in principle, though in v1 only Tim has cross-org membership and he's admin in all three.

---

## Role matrix (single-org scope)

All rows below describe permissions **within one Clerk org**. There is no cross-org access.

| Surface | Admin | Member (owners) | Viewer |
|---|---|---|---|
| Scorecard — read | Everything in this org | Everything in this org | Everything in this org |
| Scorecard — write | Any cell in this org | Own measurables only | — |
| Scorecard — status override | Any | — (can't override their own; admin enforced) | — |
| Rocks — read | All | All | All |
| Rocks — write | Any | Own only | — |
| To-Dos — read | All | All | All |
| To-Dos — write (create) | Any | Own (assign to self or others if member-led; admin can reassign) | — |
| To-Dos — write (complete) | Any | Own only | — |
| Issues — read | All | All | All |
| Issues — write (create) | Any | Any (anyone can raise an issue) | — |
| Issues — write (resolve) | Any | Own (if owner of the issue) | — |
| Meetings — start / advance / end | Yes | — (a member can be made facilitator per-meeting; that grants temporary control) | — |
| Meeting Runner editing | All cells, all panels | Their own cells; read on others' | Read only |
| Cascading Messages | Any | — | — |
| Recap send | Any | — | — |
| Audit log | Read all | Read own writes | — |

---

## The write contract (non-negotiable)

Every persistence call goes through a **server action** that:

1. Pulls the actor from Clerk (`auth()` server-side).
2. Resolves the actor's `person` row (and `role`).
3. Looks up the target entity (measurable, rock, todo, issue, meeting).
4. Checks permission per the matrix above. Reject with a typed error if denied.
5. Writes through Drizzle in a transaction.
6. Writes an `auditLog` row with:
   - `personId` — the acting Clerk user's person row
   - `action` — verb (e.g. `update_actual`, `complete_todo`)
   - `entityType` + `entityId`
   - `before` and `after` (JSON snapshots)
   - `source` — `manual | voice | fireflies | teams_native | transcript_manual | system`
   - `attributedToPersonId` — set when the source provides speaker info (e.g. Fireflies diarization identifies Daniel)
7. Broadcasts the change to Liveblocks.

This pipeline is the **only** write path. Voice commands and transcript ingestion call the same server actions — they don't have a back door.

```
client mutation ─────────────────┐
voice command ───────────────────┼──► server action (auth → permission → DB → audit → Liveblocks)
transcript proposal accepted ────┘
```

If you ever feel tempted to write to the DB outside this pipeline, that's the bug — fix the pipeline.

---

## Attribution rules for AI writes

- **Voice path:** `personId` = the logged-in facilitator (the person holding the spacebar). `attributedToPersonId` = null in v1. (Per-mic identification is a v2 idea.) `source = 'voice'`.
- **Fireflies path:** `personId` = the person who clicked "Accept" in the diff review (usually Tim). `attributedToPersonId` = the person whose voice the Fireflies diarization tagged for that proposal, when present. `source = 'fireflies'`.
- **Teams native path:** same as Fireflies. `source = 'teams_native'`. Attribution requires the Teams attendee → `people` row mapping to be configured.
- **Manual transcript path:** `personId` = uploader. `attributedToPersonId` = null. `source = 'transcript_manual'`.
- **System path:** `personId` = `null`. Used for cron-triggered rollovers (e.g. a To-Do auto-rolling over after the next L10 starts without it being marked done). `source = 'system'`.

---

## Edge cases worth deciding now

- **A member edits a measurable they no longer own.** Reject. If the owner changed mid-week, the previous owner must hand off (admin can reassign and backdate).
- **A To-Do owned by Daniel marked done by Craig.** Reject for member; admin override allowed. Reasoning: ticking off other people's work erodes accountability.
- **An issue raised by Tom can be edited by Tom.** Yes — issue ownership stays with the raiser unless admin reassigns.
- **A voice command from Tim to update Daniel's revenue.** Allowed — Tim is admin. The audit row records `personId=Tim`, `source=voice`, `attributedToPersonId=null`.
- **A Fireflies-attributed update to Daniel's revenue with Daniel as the speaker.** The accepting user is the `personId`; `attributedToPersonId=Daniel`. Daniel does not need write perms on his own measurable for this to succeed (he has them) but if the diarization were wrong and the proposal targeted, say, Andrew's revenue, the server action would still gate on the actor's permissions (admin).

---

## Read scope

- Within an org, all three roles read everything (Scorecard, Rocks, To-Dos, Issues, Meetings, audit log of own writes).
- **No cross-org reads.** Every query carries the active org-id from Clerk; the query layer asserts it matches the row's `orgId`. There is no UI affordance to view another org's data; even Tim has to switch orgs to look at the other two.
