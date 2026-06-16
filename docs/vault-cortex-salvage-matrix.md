# Vault / Cortex Salvage Matrix

Use this document before merging, copying, or archiving any of the knowledge-stack leftovers.

Candidate source repos:

- `vault`
- `vault-ui`
- `vault-gateway`
- `cortex`
- `gbrain-eval`

Default destination: `company-brain`, unless the owner decides Vault remains a separate product.

## Salvage Principle

Do not copy entire repos blindly. Salvage only patterns that are clearly better than, or clearly complementary to, the current `company-brain` architecture.

Every moved idea should answer:

1. What user/operator problem does this solve?
2. Does `company-brain` already solve it?
3. Is this implementation safer, simpler, or more production-ready?
4. What files/docs/tests prove it?
5. What is the smallest useful move?

## Comparison Matrix

| Area | Source repo/file | Existing `company-brain` pattern | Salvage decision | Action | Evidence needed |
|---|---|---|---|---|---|
| Workspace/team access | | | Keep / skip / defer | | Data model, auth checks, tests |
| Tenant isolation / RLS | | | Keep / skip / defer | | SQL policies, request scoping, tests |
| Source lifecycle | | | Keep / skip / defer | | Source statuses, retry/cursor behavior |
| Pipedrive connector | | | Keep / skip / defer | | Field coverage, freshness, failure modes |
| M365 connector | | | Keep / skip / defer | | Graph delta behavior, permission model |
| Acumatica connector | | | Keep / skip / defer | | Read-only proof, branch scoping, caps |
| Ingestion workers | | | Keep / skip / defer | | Scheduling, idempotency, retries, logs |
| Query API | | | Keep / skip / defer | | Endpoint contract, auth, citations |
| Path browsing | | | Keep / skip / defer | | `list_paths` behavior, UX need |
| Agent tools | | | Keep / skip / defer | | Tool contracts, safety, costs |
| Gateway/auth boundary | | | Keep / skip / defer | | Token model, deployment boundary |
| UI components | | | Keep / skip / defer | | Custom routes/components beyond scaffold |
| Deployment | | | Keep / skip / defer | | Railway/Vercel/Docker notes, runbooks |
| Evaluation findings | | | Keep / skip / defer | | Final report, known upstream limits |
| Fixtures/prompts | | | Keep / skip / defer | | Reusable examples, eval coverage |

## Required Inspection Steps

For each candidate repo:

1. List branches and identify non-main work.
2. Inspect root files and non-root source directories.
3. Search for secret references and credential history concerns.
4. Identify docs worth preserving.
5. Identify tests or fixtures worth moving.
6. Fill the comparison matrix above.
7. Move only approved items into `company-brain` with focused commits.
8. Add archive note to the source repo after salvage.
9. Archive only after owner approval.

## Default Decisions Unless Evidence Says Otherwise

- `gbrain-eval`: historical evidence only; capture lessons, then archive.
- `vault-ui`: archive if it remains a scaffold or thin UI shell.
- `vault-gateway`: archive if no unique gateway/auth runtime remains.
- `cortex`: archive if no unique document/context/search concepts remain.
- `vault`: strongest salvage candidate because it documents workspace/RLS/connectors/workers.

## Done Definition

The Vault/Cortex family is cleaned up when:

- this matrix is filled with evidence,
- useful patterns are moved or deliberately deferred,
- `company-brain` docs mention any adopted concepts,
- source repos contain final archive/salvage notes,
- owner approves archive actions,
- and `ops-bootstrap/docs/repo-status-index.md` reflects the final state.
