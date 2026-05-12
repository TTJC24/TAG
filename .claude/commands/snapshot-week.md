---
description: Freeze the current week's scorecard into an immutable snapshot
argument-hint: [--week <YYYY-MM-DD>] [--force]
---

# /snapshot-week

Freeze the current week's Scorecard entries into an immutable snapshot, so that history is preserved even if entries are later edited. Runs automatically on `meetings.status` → `concluded`; this command is the manual escape hatch.

## Input

- `--week <YYYY-MM-DD>` — the week-ending date to snapshot. Defaults to the current open week.
- `--force` — re-snapshot a week that already has a snapshot (writes a new versioned row; the old one is preserved).

## Flow

1. Resolve the `weeks` row for the date (create it if it doesn't exist).
2. Pull every `entries` row for that week across all in-scope measurables (org filter via Clerk).
3. Compute `computeStatus` for each one and cache the result on the snapshot.
4. Write a `weekSnapshots` row: `{ weekId, snapshotAt, takenBy, entries: jsonb, statusComputed: jsonb }`.
5. Permissions check: admin only. (Members can view snapshots; only admins can take them.)
6. Audit log: `source='manual'` or `source='system'` when triggered by cron / meeting conclude.

## Display

Print a short report:

- Week ending: YYYY-MM-DD
- Entries snapshotted: N
- Breakdown by status: G / Y / R
- Snapshot URL (deep link to the read-only snapshot view)

## Hard rules

- Snapshots are append-only. `--force` writes a new version; it never destroys.
- A snapshot is the source of truth for board packets and historical comparisons — do not edit entries on a snapshotted week without also re-snapshotting.
