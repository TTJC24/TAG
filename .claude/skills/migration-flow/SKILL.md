---
name: migration-flow
description: Run the Drizzle migration workflow safely — generate, review the SQL diff, migrate, update seed. Use whenever lib/db/schema.ts changes or the user says they need a migration.
disable-model-invocation: true
---

# Skill: migration-flow

Drizzle schema changes are a one-way door once `db:migrate` runs against a shared branch. Walk through the workflow in order and stop for human review at the SQL diff step.

## Preconditions

- The user has already edited `lib/db/schema.ts` (or about to). If not, stop and ask what schema change they intend.
- `.env.local` has `DATABASE_URL` pointing at the intended Neon branch. Confirm which branch before continuing if there is any ambiguity.

## Steps

1. **Show the schema diff.** `git diff lib/db/schema.ts` so the user sees exactly what changed. If the diff is empty, stop — there is nothing to migrate.
2. **Generate.** Run `pnpm db:generate`. List the new files under `drizzle/` (typically one `.sql` and one `_meta` update).
3. **Review the generated SQL.** Read the new `.sql` file end-to-end and surface anything that is destructive or non-trivial:
   - `DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN` type changes
   - New `NOT NULL` on an existing column with no default (will fail on existing rows)
   - Renames Drizzle inferred from add+drop (data loss risk — usually wants a hand-edited migration)
   - Index changes on large tables (lock implications)
   Stop and ask the user to confirm before running migrate if any of these are present.
4. **Migrate.** Run `pnpm db:migrate`. On failure, report the error verbatim and stop — do not retry.
5. **Update the seed.** Check whether `scripts/seed.ts` needs to know about the change (new required column, new table being populated, new enum value). If so, propose the seed edit and ask for confirmation.
6. **Verify.** Run `pnpm typecheck` to confirm Drizzle's inferred types still line up with consumers. Then run any tests under `lib/db/` if present.
7. **Summary.** One short paragraph: what changed in schema, what the SQL does, whether the seed was updated, what to click through in the app to sanity check.

## Hard rules

- Never run `db:migrate` against `DATABASE_URL` without showing the user which branch it points at first.
- Never hand-edit a generated migration without flagging it as a hand-edit and updating `_meta` accordingly.
- Never bundle a schema change with unrelated code in the same commit — schema and consumers can land together, but stay scoped.
