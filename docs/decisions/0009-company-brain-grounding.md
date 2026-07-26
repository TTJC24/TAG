# ADR 0009: Company-Brain Grounded Classification and Recommendation

Status: Accepted and implemented; disabled by default
Date: 2026-07-26

## Context

The group runs two complementary systems. `company-brain` is the knowledge
layer: it ingests M365, Acumatica, and Pipedrive for the three entities into
one read-only searchable store and answers plain-language questions over
`POST /ask` with text, citations, and a `high|medium|low` confidence grade.
This control plane is the acting layer: it classifies work, recommends actions,
gates them on human approval, and executes with an immutable audit trail —
until now using only the deterministic mock provider.

A survey of the account's repositories confirmed the consolidation:
`company-brain` is the kept knowledge layer (`cortex` dormant), this repo is
the kept control layer (`agent-os`, `tractionos`, `hermes` retired from the
active map), and Acumatica/Pipedrive reads live once — in the brain — rather
than being rebuilt here.

## Decision

Add `CompanyBrainModelProvider`, a third `ModelProvider` implementation that
grounds the existing deterministic agents in the brain's real knowledge:

- **Business rules stay here.** Task typing, priority, risk, and approval
  thresholds are still computed by the deterministic rules in this codebase.
  The brain never decides; it informs. (Phase 0 amendment: business rules do
  not live in prompts or external services.)
- **Grounding is text plus a cap.** The brain's answer is folded into the
  decision summary (first line plus up to three citation titles, bounded to the
  schema's 1000-character limit), and its confidence grade can only lower the
  final confidence (high=1.0, medium=0.85, low=0.6 cap). A low grade forces
  `needsHumanReview` on classification.
- **No forged citations.** Structured `citations` reference this database's
  own immutable source records; brain citations are external references and
  appear only as text in the summary. Fabricating source-record UUIDs would
  corrupt the audit trail.
- **Untrusted at two boundaries.** The brain's HTTP answer must pass a zod
  schema in `CompanyBrainClient` (`packages/connectors/src/company-brain.ts`),
  and the provider's final output still passes the agents'
  `parseUntrustedModelOutput` before persistence — same as every provider.
- **Fails closed.** An unreachable brain, non-2xx, non-JSON, or schema-invalid
  answer throws `CompanyBrainUnavailableError`; the job lands in the existing
  bounded-retry / dead-letter machinery (now operator-replayable per ADR 0008).
  No silent fallback to ungrounded output.
- **Disabled by default.** `resolveModelProvider` keeps `deterministic` unless
  `MODEL_PROVIDER=company_brain` and `COMPANY_BRAIN_URL` are both set
  explicitly. Entity scoping maps BLCS→blcs, FSI→fs, USA→usa, and
  CULTIVUS/unknown→shared; recommendations query the shared scope.

## Consequences

- Enabling grounding in an environment is a config change, not a code change,
  and CI never makes a network call (tests use a local stub server).
- Production enablement requires the brain's API to be reachable from the
  worker (today it sits behind Cloudflare Access; a service token header is
  supported via client options) — that wiring is deployment configuration.
- Replacing or augmenting the deterministic base with a live LLM later slots
  into the same provider seam without touching the grounding logic.
