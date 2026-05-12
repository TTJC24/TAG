# AI Tools — Shared by Voice + Transcript

A single set of Anthropic tool-use definitions powers both the live voice copilot and the post-meeting transcript ingestion. The tools are intent-only — they describe **what** the user said, not **how** to write to the DB. Every tool resolves to a server action that runs permission checks, performs the write through the standard pipeline, and emits an audit log row.

This file is the canonical definition; `lib/ai/tools.ts` is the runtime mirror and must stay in sync.

---

## Design rules

1. **One tool = one user intent.** No god-tools. Easier to reason about, easier to audit.
2. **Inputs that name a person or measurable use `*Hint` fields.** They take strings like `"Daniel"`, `"Daniel's revenue"`, `"fill rate FS"`. The server resolves the hint via fuzzy match against the live org members + active measurables. Ambiguous → the call falls through to `clarify`.
3. **Numbers always come pre-cast.** Claude is responsible for converting "one sixty-eight seven oh two" to `168702`, and percentages to decimals (`0.50`, never `50`). Currency in dollars; the server multiplies by 100 to store cents.
4. **Every tool requires a `confidence` 0–1.** Voice path: <0.8 cancels auto-apply. Transcript path: low-confidence proposals are surfaced first so the reviewer sees them.
5. **No tool ever invents a number.** If the input is "Daniel mentioned his revenue but not the value", Claude calls `clarify`, not `update_actual`.
6. **`weekId` resolves to the current week unless explicitly stated.** The runtime passes the active week as context; tool inputs accept `"this week"`, `"last week"`, an ISO date, or omit it.

---

## Tool catalog

### `update_actual`
Set the actual value for a measurable in a given week.

| Field | Type | Required | Notes |
|---|---|---|---|
| `measurableHint` | string | yes | Fuzzy resolved. |
| `weekHint` | string | no | Defaults to current week. |
| `actual` | number | yes | Decimal for percent, integer dollars for currency. |
| `note` | string | no | Free-form. |
| `confidence` | number | yes | 0–1. |

### `update_note`
Replace or append a note on a measurable's entry. Use when the user adds context without changing the number.

| Field | Type | Required |
|---|---|---|
| `measurableHint` | string | yes |
| `weekHint` | string | no |
| `note` | string | yes |
| `mode` | `"replace" \| "append"` | no, default `"append"` |
| `confidence` | number | yes |

### `override_status`
Force a status on an entry, overriding the shading engine. Rare; requires admin to actually commit.

| Field | Type | Required |
|---|---|---|
| `entryHint` | string | yes | "Daniel's revenue this week" |
| `status` | `"green" \| "yellow" \| "red"` | yes |
| `reason` | string | yes | Required — overrides need a why. |
| `confidence` | number | yes |

### `update_rock_status`
Move a Rock between `on_track | off_track | completed`. Appends to `statusHistory`.

| Field | Type | Required |
|---|---|---|
| `rockHint` | string | yes |
| `status` | enum | yes |
| `note` | string | no |
| `confidence` | number | yes |

### `complete_todo`
Mark a To-Do done.

| Field | Type | Required |
|---|---|---|
| `todoHint` | string | yes |
| `doneAt` | ISO date | no, default now |
| `note` | string | no |
| `confidence` | number | yes |

### `create_todo`
Create a new To-Do.

| Field | Type | Required |
|---|---|---|
| `description` | string | yes |
| `ownerHint` | string | yes |
| `dueDate` | ISO date | no, default = next L10 meeting date |
| `fromIssueId` | string | no | Set when the To-Do is spawned from an Issue resolution. |
| `confidence` | number | yes |

### `rollover_todo`
Roll an incomplete To-Do forward to a new due date, incrementing `rolloverCount`.

| Field | Type | Required |
|---|---|---|
| `todoHint` | string | yes |
| `newDueDate` | ISO date | no, default = next L10 meeting date |
| `confidence` | number | yes |

### `create_issue`
Create an Issue (added to the IDS list).

| Field | Type | Required |
|---|---|---|
| `title` | string | yes |
| `priority` | `"critical" \| "high" \| "medium" \| "low"` | yes |
| `ownerHint` | string | yes |
| `rootCause` | string | no |
| `confidence` | number | yes |

### `resolve_issue`
Mark an Issue resolved, optionally creating follow-up To-Dos.

| Field | Type | Required |
|---|---|---|
| `issueHint` | string | yes |
| `resolution` | string | yes |
| `createTodos` | `Array<{ description, ownerHint, dueDate? }>` | no |
| `confidence` | number | yes |

### `set_meeting_rating`
Set the 1–10 rating one attendee gave for the current meeting.

| Field | Type | Required |
|---|---|---|
| `personHint` | string | yes |
| `rating` | int 1–10 | yes |
| `confidence` | number | yes |

### `add_cascading_message`
Append to the Cascading Messages text on the current meeting.

| Field | Type | Required |
|---|---|---|
| `text` | string | yes |
| `confidence` | number | yes |

### `advance_agenda_segment`
Advance the meeting runner to the next segment. No inputs.

| Field | Type | Required |
|---|---|---|
| `confidence` | number | yes |

### `clarify`
Used when the input is ambiguous or numbers are missing. Returns a question to the user (TTS in voice path; surfaced inline in the diff review for transcript path).

| Field | Type | Required |
|---|---|---|
| `question` | string | yes |
| `aboutHint` | string | no | What the question is about, for UI grouping. |

---

## Context passed to Claude

Every call (voice or transcript) includes:

- **Meeting context block** (JSON): `meetingId`, `facilitatorId`, `attendees[]`, `currentAgendaSegment`, `currentWeek`, `entities[]`.
- **Active measurables** (JSON): `{ id, name, ownerId, ownerName, entity, goalDirection, goalValue, formatHint }[]`.
- **Open Rocks, To-Dos, Issues** (JSON, abbreviated): just enough for fuzzy match — `id`, short label, owner, due/age.
- **Recent transcript window** (voice path): last 8 utterances for disambiguation.
- **System prompt**: explains EOS / L10 vocabulary, this team's vocabulary, the hard rule "never invent numbers", and the confidence scale.

---

## System prompt (skeleton)

```
You are the meeting copilot for TractionOS, a software platform that runs
weekly EOS L10 leadership meetings for Fastening Specialists, Big League
Construction Supply, and Utility Supply Associates.

You translate spoken utterances or transcript passages into structured tool
calls. You do not invent data. If a measurable, person, or value is unclear,
you call `clarify` instead of guessing.

You know:
- The EOS vocabulary: Scorecard, Measurable, Rock, To-Do, Issue, IDS,
  Segue, Cascading Messages, V/TO.
- This team's entities: FS (Fastening Specialists), BL (Big League),
  USA (Utility Supply Associates).
- This team's people: Tim, Daniel, Nick, Andrew, Craig, Tom, Chip,
  Chris B, Mike. (Full list with roles is passed in context.)
- Confidence: 1.0 = quoted verbatim, 0.9 = clearly stated with minor
  parsing, 0.7 = inferred from context, <0.6 = guessing — prefer
  `clarify`.

Numbers:
- Percentages are decimals (50% → 0.50).
- Dollar values are integer dollars.
- "Six figures" or "ballpark" → do not guess — call `clarify`.

Voice mode: brevity matters. Call one or two tools per utterance.
Transcript mode: walk the whole transcript and emit a batch. Sort emit
order by section (scorecard updates first, then rocks, then todos, then
issues), but the diff review re-sorts by confidence.

Never bypass `clarify` when ambiguous. Daniel saying "my revenue" with no
number is a `clarify` call, not an `update_actual`.
```

(The skeleton above is the seed. Few-shot examples — drawn from anonymized reference transcripts — go in `lib/ai/prompts/voice.ts` and `lib/ai/prompts/transcript.ts`.)
