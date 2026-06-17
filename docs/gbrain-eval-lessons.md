# gbrain-eval Salvage Lessons

`gbrain-eval` is historical evidence, not an active product dependency. Company Brain keeps the useful lessons here so the old evaluation repo can be archived after owner approval.

## What Was Learned

- Source isolation matters as much as recall. Play B proved a dedicated `m365-calendar` source could stay isolated from the default source when queries were explicitly scoped.
- Provenance must be persisted, not merely returned. The upstream `ingest_capture` path validated `IngestionEvent` fields but did not write `source_id`, `source_kind`, and `source_uri` through to the page row in the tested version.
- A useful provenance receipt has three layers: accepted event, returned job metadata, and persisted row metadata. A second ingest should also remain idempotent inside the same source.
- Citations need stable `source_uri` values that point back to the source-system record or a safe virtual path.
- Raw imports are not enough for operational knowledge. Real company records need connector-owned normalization, content hashes, cursor/retry behavior, and failure states.
- Synthesis cannot be treated as verified when the model credential path fails. Play A/B retrieval and embedding worked, but LLM synthesis was blocked by missing Anthropic credentials and OpenAI quota.

## What Company Brain Already Implements

- `bun run provenance:check` verifies connector fixture events carry `source_id`, `source_kind`, protocol-shaped `source_uri`, `content_hash`, and operator-visible provenance.
- `bun run source-isolation:check` verifies source-scoped search, empty requested source lanes, and refusal to answer authoritatively when matching records lack stable provenance.
- `bun run eval:citations` verifies search-hit source URI preservation and answer citations with non-empty source ID plus protocol-shaped source URI.
- `bun run eval:answers` covers broader answer behavior and source-lane expectations across Acumatica, Pipedrive, and M365-style collaboration records.
- `docs/source-lifecycle-and-provenance.md` records the lifecycle fields, virtual path rules, health/freshness expectations, and live-readiness gap.

## Do Not Import

- Do not import PersonalOS snapshots, local gbrain PGLite data, or raw M365 snapshots from `gbrain-eval`.
- Do not adopt the direct-write workaround as a permanent architecture. Company Brain should keep proving provenance at its own connector and persistence boundary.
- Do not depend on `gbrain-eval` scripts for production. Treat them as historical evaluation notes only.

## Future Eval Ideas

- Add a provenance-receipt regression if Company Brain introduces an async ingestion job path: accepted event, job result, persisted page, and idempotent replay must agree.
- Add sanitized connector fixtures only when they improve answer quality or source isolation beyond the current fixture set.
- Keep LLM-backed synthesis gates separate from retrieval/provenance gates so missing or quota-limited model credentials do not masquerade as retrieval failures.
