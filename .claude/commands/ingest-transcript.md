---
description: Parse a meeting transcript and produce a proposed-changes diff for review
argument-hint: <transcript-path-or-url> [--meeting-id <id>]
---

# /ingest-transcript

Ingest a meeting transcript and produce a structured diff of proposed updates across the Scorecard, Rocks, To-Dos, IDS, and meeting rating. Do **not** apply the changes — present them for per-row review.

## Input

`$ARGUMENTS` is either:
- A path to a local `.txt`, `.vtt`, or `.docx` file
- A URL to a transcript (Fireflies, OneDrive, etc.)
- An empty arg → ask the user to paste the transcript inline

If `--meeting-id` is not provided, list the recent `meetings` rows in `scheduled` or `live` state and ask the user to pick one.

## Flow

1. Resolve the transcript through the `TranscriptSource` adapter:
   - Fireflies URL → `lib/ai/transcript/fireflies.ts`
   - Teams URL or `--source=teams` → `lib/ai/transcript/teams.ts`
   - Otherwise → `lib/ai/transcript/manual.ts`
2. Normalize to `{ utterances, rawText, durationSec }`.
3. Pull current scorecard schema + open Rocks + open To-Dos + open Issues for the meeting's org scope.
4. Call Claude Sonnet 4 with the tool definitions in `docs/ai-tools.md` and the system prompt from `lib/ai/prompts/transcript.ts`. The model emits a batch of tool calls; do **not** execute them — collect them.
5. For each proposed tool call, compute the before/after diff against the live DB (without writing).
6. Render the diff sorted by `confidence` ascending (lowest first), grouped by section (Scorecard → Rocks → To-Dos → Issues → Meeting). Each row shows:
   - The tool call name + resolved target
   - Before / After
   - Confidence
   - Speaker attribution (if diarization available)
   - Checkbox: Accept | Reject
7. On accept, route through the same server actions as manual UI edits. `source` on the audit row is `fireflies | teams_native | transcript_manual`.

## Hard rules

- **Never invent numbers.** If the transcript didn't say a value, the tool call must be `clarify`, not a `update_actual` with a guess.
- **Never auto-apply.** This command produces a review screen, period.
- Confidence < 0.6 → surface a warning banner above the row.
- If the same measurable is touched twice in the transcript, take the *later* statement (most recent override).
