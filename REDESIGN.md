# TractionOS — Ultra-UI + Brain Redesign

> Presentation-layer reimagining. ALL data fetching, server actions, Clerk auth,
> Liveblocks wiring, and the shading engine (`lib/shading/compute-status.ts`) are
> preserved EXACTLY. This document defines the elevated visual language, the strict
> component API every implementer codes against, per-surface direction, and the
> company-brain integration architecture. No new dependencies. TypeScript strict-clean.

---

## 1. Design philosophy — "Operational command-center"

TractionOS is the room where a leadership team runs a weekly L10 and where one operator
(Tim, COO of FS/BLCS/USA) reads the state of three companies at a glance. The redesign
target is **a high-end ops console, not a marketing SaaS site**:

- **Dense and information-rich without clutter.** Every pixel earns its place. We remove
  decorative chrome, tighten the grid, and let the data be the texture. The matte-graphite
  base recedes; numbers and status are the only things that pop.
- **Status is the only color.** Green / yellow / red stay reserved for risk, blocked,
  trend, completion, urgency — exactly as the shading engine computes them. Everything
  else is neutral graphite. We make status *crisper* (sharper edges, a thin leading
  status spine on rows, calibrated alpha) rather than louder.
- **Keyboard-first where it helps an operator.** The L10 is run live; reaching for a mouse
  costs momentum. We add a small, consistent keyboard layer (focus rings, `j/k` row nav
  hooks, `/` to focus brain search, `g` then a letter to jump tabs) layered on top of the
  existing controls — never replacing a server action, only adding a faster trigger.
- **Fast, restrained motion.** CSS + `tailwindcss-animate` only (Framer Motion is NOT
  installed). Transitions are ≤150ms, ease-out, and only on color/opacity/transform.
  Nothing slides or bounces. Motion confirms an action; it never decorates.
- **Premium dark feel.** Deeper background, a real elevation ladder, hairline borders, a
  single accent of paper-bright focus. Tabular Geist Mono for every figure.

---

## 2. Elevated token system

Built on the existing `.dark` block in `app/globals.css`. We **keep every existing token
name and the three status channels unchanged** (the shading engine and `StatusCell` depend
on `--status-green/yellow/red`). We ADD a denser elevation ladder, focus tokens, spacing
and motion scales. Light tokens (Clerk sign-in) are untouched.

### 2.1 Neutral / surface ladder (`.dark`)

Refine the existing values into a 4-tier elevation ladder so panels, popovers and the dock
read as distinct depths instead of one flat gray. Keep variable names identical.

```css
.dark {
  /* Base — slightly deeper than today (was 7%) for more contrast headroom */
  --background: 220 16% 6%;
  --foreground: 210 16% 93%;

  /* Elevation ladder (NEW semantic, mapped onto existing names + 2 additions) */
  --surface-0: 220 16% 6%;     /* page bg            (== background) */
  --surface-1: 220 14% 9%;     /* panel / card       (== card) */
  --surface-2: 220 14% 12%;    /* raised: popover, dock, dialog header */
  --surface-3: 220 13% 16%;    /* hover / active row, input wells */

  --card: 220 14% 9%;
  --card-foreground: 210 16% 93%;
  --popover: 220 15% 11%;       /* lifted off card, was 6% */
  --popover-foreground: 210 16% 93%;

  --primary: 210 16% 93%;
  --primary-foreground: 220 16% 6%;
  --secondary: 220 12% 14%;
  --secondary-foreground: 210 16% 93%;
  --muted: 220 12% 14%;
  --muted-foreground: 215 11% 60%;   /* +2% L for legibility on deeper bg */
  --accent: 220 12% 16%;
  --accent-foreground: 210 16% 93%;
  --destructive: 0 70% 55%;
  --destructive-foreground: 210 40% 98%;

  /* Borders — two weights */
  --border: 220 10% 18%;             /* standard separator (unchanged) */
  --border-strong: 220 12% 26%;      /* NEW: panel outline, focus-adjacent */
  --input: 220 10% 18%;

  /* Focus — paper-bright, the single non-status accent */
  --ring: 210 18% 80%;

  /* Status channels — UNCHANGED. Do not touch; shading engine depends on these. */
  --status-green: 145 55% 50%;
  --status-yellow: 40 92% 58%;
  --status-red: 0 75% 60%;

  /* NEW: brain accent — a cool slate-cyan used ONLY for brain provenance,
     never for status. Distinguishable from green/yellow/red at a glance. */
  --brain: 199 80% 62%;
}
```

`--surface-2`, `--surface-3`, `--border-strong`, and `--brain` are the only new variables.
Expose them in `tailwind.config.ts` as `surface.0/1/2/3`, `border-strong`, and `brain`.

### 2.2 Spacing & density scale

The app is a data console; default Tailwind spacing is too generous. Standardize a **dense
row rhythm**:

- Page gutter: `container` (unchanged, 2rem) — keep.
- Panel inner padding: `px-4 py-2.5` for headers (existing `.panel-header`), `px-4 py-3`
  for bodies.
- **Table row height: 2.25rem (`h-9`) standard, 2.75rem (`h-11`) in meeting mode.**
- Cell gutters: `px-3` horizontal, vertical centered. Numeric cells right-aligned.
- Gap between stacked panels on a surface: `gap-3` (0.75rem). No `gap-6` sprawl.

### 2.3 Border & elevation treatment

- Panels: `1px` `--border`, on `--surface-1`. No drop shadows on panels.
- Raised float (dialog, dock, popover): `--surface-2`, `1px` `--border-strong`, plus the
  existing `shadow-2xl`. Backdrop `bg-black/70 backdrop-blur-sm` (keep dialog behavior).
- **Status spine:** dense list rows (rocks, todos, issues) get a `2px` left inset border
  in the row's status color at low alpha (`/40`) — a leading "spine" that lets an operator
  scan a column of status without reading chips. Implemented as `box-shadow: inset 2px 0 0`,
  never as layout-shifting border. Neutral rows get no spine.
- Hairline `.rule` (existing) between dense rows — keep.

### 2.4 Focus rings (keyboard-first)

One consistent focus treatment, paper-bright, never status-colored:

```css
.focus-ring {
  @apply outline-none ring-1 ring-ring ring-offset-1 ring-offset-background;
}
```

Apply `focus-visible:` variants on every interactive control (buttons, cells, checkboxes,
selects, row anchors). Existing controls use `focus:border-ring` — superset it by ADDING
`focus-visible:ring-1 focus-visible:ring-ring` so keyboard focus is unmistakable without
breaking mouse styling.

### 2.5 Typography scale

Keep Geist Sans (UI) + Geist Mono (figures, labels, status). Tabular numerics everywhere a
number appears.

| Token             | Use                              | Spec |
|-------------------|----------------------------------|------|
| `.eyebrow`        | section/org labels (existing)    | mono 10px, upper, tracking .18em, muted |
| `numeric-xl`      | hero current-week reading        | mono 2xl, semibold, tabular |
| `numeric-md`      | row figures                      | mono base, medium, tabular |
| `numeric-sm`      | secondary/goal figures           | mono xs, muted, tabular |
| heading           | panel titles                     | sans 14px (`text-sm`) semibold |
| body              | descriptions, notes              | sans 13px (`text-[13px]`) |
| chip / status     | `.chip` (existing)               | mono 10px, upper, tracking .16em |

All four `.numeric-*` + `.eyebrow` + `.chip*` utilities are PRESERVED unchanged.

### 2.6 Motion rules

- Allowed: `transition-colors`, `transition-opacity`, `transition-transform`, duration
  `100–150ms`, `ease-out`. Plus `tailwindcss-animate` `accordion-down/up` (existing) and
  `animate-in fade-in`/`slide-in-from-bottom-2` for the dock/dialog mount.
- A new keyframe `pulse-status` (subtle 2s opacity 1↔.55) for a single live "saving…" dot.
- No motion on hover of table rows beyond `bg` color change. No parallax, no spring.
- Meeting mode disables all non-essential motion via `body[data-meeting="1"]`.

---

## 3. Primitive & component inventory

Three groups: **PRESERVED** (exact name + props kept; may be visually re-skinned and given
a backward-compatible superset of props), **NEW** (added primitives), and **EXTENDED**
(existing component, new optional props only).

### 3.1 Preserved primitives (`components/ui/primitives.tsx`)

`OwnerChip`, `StatusChip`, `MissingMarker`, `TrendStrip` (+`TrendPoint`), `Panel`,
`PanelHeader`, `EmptyBlock`, `Eyebrow` — names and required props unchanged. See the
contract for exact signatures and the optional props added.

### 3.2 Preserved status / control components

`StatusCell`, `RockStatusPill`, `RockStatusSelect`, `NotesEditor` (+ `RockNotesEditor`,
`TodoNotesEditor`, `IssueNotesEditor`), `TodoCheckbox`, `TodoRolloverButton`,
`IssueActionButtons`, `EditableEntryCell`, `EditableGoalCell`, `ReadinessBanner` — all
preserved. All server-action invocations identical.

### 3.3 Dialog primitives (`components/ui/dialog.tsx`)

`Dialog`, `FormField`, `inputCls`/`textareaCls`/`selectCls`, `FormActions`, `CancelButton`,
`SubmitButton`, `FormError` — preserved. `inputCls` re-skinned to `--surface-3` well +
focus ring; string export unchanged so all dialogs inherit it.

### 3.4 New primitives (`components/ui/primitives.tsx`, additive)

- **`StatusDot`** — 1.5×1.5 round status indicator (the canonical leading marker).
- **`MetricStat`** — eyebrow label + `numeric-xl` value + optional delta; the summary-pill
  replacement at the top of Scorecard / Readiness.
- **`SummaryBar`** — horizontal strip of `MetricStat`/count pills (red/yellow/green/missing
  counts) used on Scorecard, Readiness, and section headers.
- **`DataTable` / `Th` / `Td`** — thin, unstyled-logic table shell enforcing the dense row
  rhythm, sticky header, right-aligned numeric columns, and optional sortable headers.
  These are PRESENTATION ONLY; sorting state is local UI, never changes query order unless a
  surface already sorts client-side (issues by priority does).
- **`KeyHint`** — a tiny mono kbd badge (`/`, `⏎`, `g s`) for the keyboard layer.
- **`SegmentedControl`** — pill toggle group used for list filters (e.g. todos: all /
  overdue / rolled). Pure client filter over already-fetched rows.
- **`BrainBadge`** — small `--brain`-tinted chip marking brain-sourced content (dock).

### 3.5 New shell components

- **`CommandStrip`** — optional per-surface sub-header beneath `TopBar`: surface title +
  `SummaryBar` + right-aligned controls (Add button, `SegmentedControl`, `KeyHint`s).
- **`TopBar`** (EXTENDED) — re-skinned, gains active-nav indication and `g`-jump key hints;
  same async data, same nav filter, same Clerk controls.

### 3.6 Jerry dock (EXTENDED → "Copilot dock")

`JerryDock` keeps its name, position, ask/approve/skip flow, and `/api/jerry/ask` +
`/api/jerry/apply` calls EXACTLY. It gains a **mode toggle** (Ask Jerry ↔ Search Brain).
Brain mode posts to the NEW `/api/brain/search`, renders hits as `BrainBadge`-marked
citations, and lets the user "Send to Jerry" (prepends selected brain context into the next
Jerry prompt client-side — no server change to the Jerry path). See §5.

---

## 4. Per-surface direction

See the structured `surfaces` output for the implementer-level detail on each of:
scorecard, rocks, todos, issues, me, readiness, home. Summary of intent:

- **Scorecard:** lead with a `SummaryBar` of red/yellow/green/missing `MetricStat`s; turn
  the KPI grid into a sticky-header `DataTable` with a frozen first column (measurable +
  owner + goal), `StatusCell`s per week, `TrendStrip` rail. Density toggle.
- **Rocks / To-Dos / Issues:** convert card sprawl into spine-led `DataTable` rows;
  `SegmentedControl` filters; status spine + chip; inline editors unchanged.
- **Me:** L10 prep cockpit — `ReadinessBanner` hero, then four tight panels (measurables,
  rocks, todos, issues) sorted red-first, keyboard `j/k` row traversal.
- **Readiness:** admin accountability board; per-person rows with status spine, owes
  summary, missing/overdue counts as `MetricStat`s; sort preserved.
- **Home:** quiet org-picker / redirect surface; centered brand + state.

---

## 5. Company-brain integration architecture

The brain (gbrain-based KB over Acumatica + Pipedrive + M365) is integrated **parallel to
Jerry**, copying the Jerry adapter pattern. It does NOT touch the existing Jerry request path.

### 5.1 Client — `lib/brain/client.ts` (NEW)

Mirrors `lib/jerry/client.ts`:

```ts
// Env: COMPANY_BRAIN_API_URL, COMPANY_BRAIN_API_TOKEN
//      optional COMPANY_BRAIN_TIMEOUT_MS (default 15000)
export class BrainNotConfiguredError extends Error {}
export class BrainRequestError extends Error { status?: number; body?: string; }

export interface BrainHit { slug: string; source_id: string; title: string; chunk_text: string; }
export interface BrainSearchResult { hits: BrainHit[]; }

export function isBrainConfigured(): boolean;        // url && token present
export async function brainSearch(opts: {
  query: string; sources?: string[]; limit?: number;
}): Promise<BrainSearchResult>;                       // POST {url}/search, Bearer token
export async function brainSources(): Promise<{ sources: string[] }>;  // GET /sources
```

Auth header `Authorization: Bearer ${COMPANY_BRAIN_API_TOKEN}`. Same AbortController
timeout + tolerant JSON parse pattern as Jerry. Add `isBrainConfigured()` alongside
`isJerryConfigured()`.

### 5.2 Mapping brain → app citation shape

A `BrainHit` maps to the existing `JerryCitation` shape so the dock renders both uniformly:

```ts
function brainHitToCitation(h: BrainHit): JerryCitation {
  return { source: h.title || h.slug, snippet: h.chunk_text, href: undefined };
}
```

(`href: undefined` per spec — brain hits have no public URL.) Brain citations are tagged in
the dock with a `BrainBadge` so provenance (brain vs Jerry vault) is visible.

### 5.3 Route — `app/api/brain/search/route.ts` (NEW)

Mirrors `/api/jerry/ask` structure (Clerk auth via `getAuthContext`, same error envelope):

**Request** `POST /api/brain/search`
```json
{ "query": "string (required, trimmed)", "sources": ["acumatica", "..."]?, "limit": 8? }
```

**Response 200**
```json
{
  "hits": [{ "slug": "...", "source_id": "acumatica", "title": "...", "chunk_text": "..." }],
  "citations": [{ "source": "title||slug", "snippet": "chunk_text", "href": null }],
  "sources": ["acumatica","pipedrive","m365-mail", ...]
}
```
`citations` is the pre-mapped `JerryCitation[]` for direct dock rendering; `hits` is the raw
passthrough; `sources` is the available source list (from a cached `brainSources()` call) so
the dock can render source filters.

**Errors** (same envelope as Jerry): `503 { error, code: "not_configured" }` when
`!isBrainConfigured()`; `502 { error, code: "upstream_error", status, body }` on
`BrainRequestError`; `401 { error }` on auth; `400 { error }` on bad body; `500` generic.

### 5.4 Dock flow (in `components/jerry-dock.tsx`)

- A `SegmentedControl` at the dock header toggles `mode: "jerry" | "brain"`.
- **Jerry mode:** unchanged — `send()` posts `/api/jerry/ask`, renders reply + intents +
  citations, Approve/Skip via `/api/jerry/apply`.
- **Brain mode:** `send()` posts `/api/brain/search`; the response's `citations` render as a
  read-only brain result turn (no action intents). Each hit shows a `BrainBadge`, title, and
  snippet. A per-turn **"Send to Jerry"** affordance copies the selected hits' text into the
  composer prefixed as context, then switches to Jerry mode — so the operator can ask Jerry a
  question grounded in brain results without any change to the Jerry server contract.
- Brain `not_configured` is handled gracefully with the same helpful-message pattern Jerry
  uses ("Company brain is not configured. Set COMPANY_BRAIN_API_URL and
  COMPANY_BRAIN_API_TOKEN.").
- `ChatTurn` gains optional `source?: "jerry" | "brain"` to drive badge rendering. Existing
  fields unchanged; defaults to `"jerry"` for backward compatibility.

### 5.5 Env — `.env.example` (additive)

```
# Company Brain (gbrain KB — Acumatica + Pipedrive + M365)
COMPANY_BRAIN_API_URL=
COMPANY_BRAIN_API_TOKEN=
# COMPANY_BRAIN_TIMEOUT_MS=15000
```
Also add the missing Jerry vars (`JERRY_ADAPTER_URL`, `JERRY_ADAPTER_KEY`) while there.

---

## 6. Backward-compatibility guarantee

Every shared component name in the codebase map keeps its name and required props. All
additions are **optional props** or **new components**. No server action signature,
query, or status-color meaning changes. `tsc --noEmit` must pass.
