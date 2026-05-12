---
description: Convert an Issue into one or more To-Dos with the issue retained as parent
argument-hint: <issue-id-or-title> [--owner <person>] [--due <YYYY-MM-DD>]
---

# /promote-issue-to-todo

Take an open Issue and spawn one or more To-Dos from it, linking each new To-Do to the parent Issue. The Issue stays open until explicitly resolved — promotion is not resolution.

## Input

- Positional: issue ID (e.g. `iss_01H...`) or a fuzzy title fragment. If multiple match, list them.
- `--owner <hint>` — defaults to the Issue's owner. Fuzzy resolved.
- `--due <YYYY-MM-DD>` — defaults to the next L10 meeting date.
- `--multiple` — interactive mode: prompt the user for each To-Do they want to spawn.

## Flow

1. Resolve the Issue. If ambiguous, list and ask.
2. Single-To-Do mode (default):
   - Use the Issue's title as the To-Do description (prompt to edit).
   - Owner = `--owner` or Issue owner.
   - Due = `--due` or next meeting.
   - Create the To-Do with `parentIssueId = issue.id`.
3. Multiple-To-Do mode (`--multiple`):
   - Loop: ask for description, owner, due. Empty description ends the loop.
   - Each created To-Do links back to the parent Issue.
4. The Issue's `status` stays `open` (or `ids_in_progress`, if it was). To close it, use the IDS panel's "Resolve" action (which can also spawn To-Dos via `resolve_issue` — that's the meeting-runner path; this slash command is the out-of-meeting alternative).
5. Audit log: one row per To-Do created. `source='manual'` when invoked here.

## Permissions

- Admin: any Issue, any owner.
- Member: only Issues they raised; To-Do owner can be self or anyone (per the matrix in `docs/permissions.md`).
- Viewer: rejected.

## Heuristics worth keeping

- If the Issue is older than 14 days and being promoted, suggest that the IDS process never converged — prompt the user to confirm rather than just spawn a To-Do.
- A single Issue with three rolled-over To-Do descendants should itself be re-IDS'd. The command surfaces a warning when that pattern is detected.
