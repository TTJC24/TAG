# ADR 0003: Declarative Approval Policy

Status: Accepted and implemented

Date: 2026-07-25

Decision owner: Phase 2 reviewer

## Decision

Approval policy is immutable, organization-scoped, versioned data evaluated by
one deterministic pure function. Rules do not live in prompts, route handlers,
workers, or scattered conditionals.

The evaluator accepts a typed `(task, recommendation, requested action)` input
and one immutable policy version. It does not read the clock, database,
network, model provider, or environment. It returns:

- effect: `auto_approve`, `requires_approval`,
  `requires_n_approvers`, or `blocked`;
- approver count and required permission;
- requester/approver separation flags;
- reason code;
- policy-version ID and content hash.

Unknown or malformed policy input fails typed validation before evaluation.
Policy does not grant permissions and cannot expose a capability absent from
the deployed phase.

## Rule schema

Each ordered rule stores:

```text
id
organization_id
policy_version_id
ordinal
name
predicate
outcome
reason_code
```

Predicates are typed expression trees over an allowlist:

- task organization, type, category, financial exposure/currency, source type,
  and source system;
- recommendation risk level and type;
- requested action type, target system, and cross-entity flag.

Supported operators are `eq`, `not_eq`, `gt`, `gte`, `lt`, `lte`, `in`,
`exists`, `all`, `any`, and `not`. They are data interpreted by the single
evaluator, not arbitrary SQL or executable code. Rules use unique ascending
ordinals and first-match semantics.

## Storage and immutability

- `approval_policy_versions` and `approval_policy_rules` are immutable.
- A change creates a complete new version; update/delete is trigger-rejected
  and unavailable to the application role.
- `approval_policy_bindings` is the guarded active-version projection.
- `approval_policy_activation_requests` and
  `approval_policy_activations` are immutable facts.
- Every approval decision and approval-resolution audit event stamps the exact
  policy-version ID and content hash.
- Every non-bootstrap activation appends an immutable policy activation and a
  hash-chained audit event in the same transaction. A deferred constraint
  rejects an unaudited activation.

Direct pointer changes are rejected. Application access is organization-scoped
and protected by forced RLS.

## Activation control

New-version activation is a two-person action:

1. an authorized author creates an immutable candidate version;
2. the author submits an activation request;
3. a different authorized actor activates it against the expected binding
   version.

The database rejects author-as-activator and rejects new-version activation
without a valid request from a distinct actor. Application services enforce
the same permissions before calling the guarded database functions.

Reverting to a version that this organization previously activated is a
single-actor break-glass operation. It still requires activation permission,
expected binding version, reason, trace ID, immutable activation fact, and
audit event. This prevents an incident from deadlocking on a second actor
without creating a path for one person to activate unreviewed content.

Bootstrap is deterministic seed data under a migration-only guard. Runtime
roles lack insert/update/delete grants on policy versions, rules, bindings, or
activation facts, so the seed path is not a reusable single-actor backdoor.

## Phase 1 cutover

Seeded policy version 1, labeled `phase1-v1-data`, expresses the original
behavior exactly:

| Risk | Effect              | Compatibility result                             |
| ---- | ------------------- | ------------------------------------------------ |
| 0–2  | `auto_approve`      | allowed, no approval, `low_risk_internal_action` |
| 3–4  | `requires_approval` | allowed, approval, `human_approval_required`     |
| 5    | `blocked`           | prohibited, `risk_5_write_prohibited_in_phase1`  |
| 6+   | `blocked`           | prohibited, `risk_6_prohibited`                  |

The deterministic reference evaluator remains only as a test oracle. The
worker loads the active immutable policy and uses the declarative evaluator.
The equivalence suite runs identical boundary inputs through both paths and
compares all behavioral fields. Phase 2 changes where rules live, not their
behavior.

## Proof

Unit and clean-PostgreSQL feature tests prove:

- exact behavioral equivalence to `phase1-v1`;
- malformed or out-of-scope policy input fails closed;
- author-as-activator is rejected;
- a new version cannot be activated by one actor;
- a reviewed new version can be activated by a distinct actor;
- an already approved prior version can be restored by one authorized actor;
- the pointer change and policy activation are audited; and
- approval and resolution records retain the policy-version identity.

## Consequences and boundary

Policy authoring and activation are service/database capabilities in this
slice; no new administration screen was added. Multi-approver collection is
representable in the policy schema but is not implemented by the selected
internal approval-resolution slice. Risk 5 and risk 6 remain blocked, and no
external action follows an approval.
