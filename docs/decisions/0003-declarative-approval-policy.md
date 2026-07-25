# ADR 0003: Declarative Approval Policy

Status: Proposed — awaiting decision

Date: 2026-07-25

Decision owner: Phase 2 reviewer

## Decision requested

Approve or revise the proposed immutable, organization-scoped policy model and
change-control process. This document defines the representation and cutover
proof only. It does not authorize a policy engine, migration, seed, or behavior
change.

## Context

Phase 1 keeps every approval rule in one deterministic function in
`packages/workflows/src/index.ts`. Its decisions carry the code version
`phase1-v1`. The current observable behavior is:

| Input    | Allowed in phase | Requires approval | Reason                              |
| -------- | ---------------- | ----------------- | ----------------------------------- |
| Risk 0–2 | Yes              | No                | `low_risk_internal_action`          |
| Risk 3–4 | Yes              | Yes               | `human_approval_required`           |
| Risk 5   | No               | Yes               | `risk_5_write_prohibited_in_phase1` |
| Risk 6+  | No               | Yes               | `risk_6_prohibited`                 |

This centralization is safe for the manual Phase 1 slice, but changing policy
requires a code release and cannot support independently reviewed
organization-specific versions. Moving rules to data must preserve the
existing deterministic boundary: policies never grant permissions, never
execute actions, and never live in prompts.

## Proposed decision

Store approval policies as immutable organization-scoped versions containing
ordered, typed rules. Maintain one guarded active-version pointer per
organization and policy key. Evaluate a pinned version with one deterministic
pure evaluator. Stamp the exact policy version and content hash into every
approval decision and audit event.

### Rule semantics

A rule contains:

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

`predicate` is a typed expression tree over an allowlisted input vocabulary,
not arbitrary SQL, JavaScript, templates, or prompt text.

Initial field vocabulary:

- `task.organization_id`
- `task.task_type`
- `task.category`
- `task.financial_exposure.amount`
- `task.financial_exposure.currency`
- `task.source_type`
- `task.source_system_id`
- `recommendation.risk_level`
- `recommendation.recommendation_type`
- `requested_action.action_type`
- `requested_action.target_system`
- `requested_action.cross_entity`

Initial operators:

- scalar: `eq`, `not_eq`, `gt`, `gte`, `lt`, `lte`, `in`, `exists`;
- boolean composition: `all`, `any`, `not`.

All values use canonical types. Monetary comparisons require an explicit
currency or a separately approved conversion source and timestamp; the first
version performs no currency conversion. Unknown or malformed fields fail
closed.

Rules evaluate in unique ascending `ordinal` order and the first matching rule
wins. Every policy version must end in an unconditional default rule so there
is no implicit fallthrough. Activation validation rejects duplicate ordinals,
unknown fields/operators, invalid outcome combinations, missing defaults, and
unreachable rules detected by the supported validator.

### Outcome schema

```text
effect:
  auto_approve
  requires_approval
  requires_n_approvers
  blocked

approver_count
approver_permission
requester_must_be_distinct
approvers_must_be_distinct
reason_code
```

Constraints:

- `auto_approve` has zero approvers.
- `requires_approval` has exactly one approver.
- `requires_n_approvers` has at least two distinct approvers.
- `blocked` cannot be overridden by an approval and creates no executable
  action.
- An approval outcome identifies a permission such as `approval:decide`; it
  never names a user directly and never grants that permission.
- Authentication, organization membership, action capability, and
  separation-of-duties checks remain independent deny-by-default controls.
- The final authorization result is deny-wins. Policy may add approval
  requirements or block an action, but it cannot authorize a capability that
  the deployed phase does not expose or weaken a structural prohibition.

For compatibility with Phase 1, `blocked` maps to
`allowedInPhase = false` and `requiresApproval = true` in the existing response
shape. The richer effect is additive; it does not make risk-5 or risk-6 work
approvable.

## Proposed storage

Conceptual schema:

```text
approval_policy_versions
  id
  organization_id
  policy_key
  version_number
  schema_version
  human_label
  description
  content_hash
  supersedes_version_id
  created_by_user_id
  created_at

approval_policy_rules
  id
  organization_id
  policy_version_id
  ordinal
  name
  predicate_json
  outcome_json
  reason_code

approval_policy_bindings
  organization_id
  policy_key
  active_policy_version_id
  binding_version
  activated_by_user_id
  activated_at

approval_policy_activations
  id
  organization_id
  policy_key
  previous_policy_version_id
  activated_policy_version_id
  expected_binding_version
  activated_by_user_id
  reason
  trace_id
  activated_at
```

Design rules:

- Versions and rules are immutable from insertion; application roles receive
  no update/delete capability.
- A version and its complete rule set are created atomically. Revising even one
  predicate creates a new complete version with a new content hash.
- Every organization has an explicit version and binding. Identical seeded
  content may share a hash, but no organization silently inherits another
  organization's active pointer.
- `approval_policy_bindings` is the current-state projection. Only a guarded
  activation function may move it, using an expected binding version.
- The activation transaction appends an activation fact and a chained audit
  event containing the old/new policy IDs and hashes. Direct pointer writes are
  rejected.
- Deactivation without a replacement is prohibited. A fail-closed policy can
  be activated when operations must stop.
- Historic decisions reference the immutable policy-version ID and content
  hash, not the mutable active pointer or only a human label.

## Deterministic evaluation

The evaluator is a pure function:

```text
evaluate(canonical_policy_input, immutable_policy_version)
  -> policy_decision
```

The input is constructed and schema-validated before evaluation. The evaluator
does not read the clock, database, network, environment variables, model
output, or active pointer. Loading and authorization happen outside it.

At decision time, the transaction resolves and pins the active
policy-version ID. Every retry for the same idempotent command reuses that
pinned version and prior decision. A later policy activation does not
reinterpret historic or in-flight decisions. Re-evaluation requires an
explicit authorized command that records the old and new results.

The persisted decision and audit event include:

- policy-version ID, human label, schema version, and content hash;
- canonical policy-input hash;
- effect, approver count/permission, separation constraints, and reason code;
- evaluator version;
- actor, organization, workflow, trace, and command IDs.

No chain-of-thought or model reasoning is involved.

## `phase1-v1` cutover and equivalence proof

The first data-driven content is an organization-scoped representation of the
existing rules, labeled `phase1-v1-data`. In order:

1. risk at least 6 → `blocked`, `risk_6_prohibited`;
2. risk equal to 5 → `blocked`, `risk_5_write_prohibited_in_phase1`;
3. risk from 3 through 4 → `requires_approval`,
   `human_approval_required`;
4. unconditional default for valid risk 0–2 → `auto_approve`,
   `low_risk_internal_action`.

Cutover implementation must:

1. preserve the current code evaluator as the reference oracle;
2. seed a separate immutable version for each organization with the same
   canonical content hash;
3. run the existing policy tests through both evaluators;
4. add boundary and invalid-input fixtures for risks below zero, 0, 2, 3, 4,
   5, 6, and above 6, with representative requested-action values;
5. compare the complete compatibility projection:
   `allowedInPhase`, `requiresApproval`, `reasonCode`, and the expected version
   identity mapping;
6. shadow-evaluate real non-production Phase 1 fixtures and fail on any
   mismatch;
7. activate the data version only after equivalence is exact; and
8. remove conditional business branches from the legacy module only after the
   data evaluator is authoritative and rollback to the prior binding is
   tested.

The version label changes from `phase1-v1` to an immutable version ID plus the
`phase1-v1-data` label; all behavioral fields remain identical. Any intended
policy behavior change requires a separate ADR and new tests.

## Change control

Use capabilities rather than broad role names:

- `approval_policy:author` may submit one complete immutable candidate version
  for organizations in the user's authorized scope.
- `approval_policy:review` may inspect and compare versions but cannot activate.
- `approval_policy:activate` may move the guarded pointer after validation.
- The activator must be different from the author.
- System administrators do not receive author or activate permission merely by
  being administrators.
- Agents, connector identities, model runtimes, operators, and ordinary
  approvers cannot author or activate policy.

Activation requires an exact diff, validation report, reason, expected current
binding version, and explicit human action. Batch cross-organization activation
is excluded initially. Every organization is changed separately and audited
separately.

All rules remain in one data model interpreted by one evaluator. Prompts may
describe a resulting decision to a user but may neither contain rules nor
determine the outcome.

## Alternatives

- **Keep code-versioned rules indefinitely:** simple but makes reviewed,
  organization-specific activation and historical comparison operationally
  expensive.
- **Editable JSON policy document:** easy to build but destroys exact historic
  reproducibility.
- **Arbitrary SQL or scripting:** expressive but creates a code-execution and
  nondeterminism boundary.
- **Rules embedded in prompts:** untestable as an authorization control and
  explicitly prohibited.
- **One global active pointer:** permits a cross-entity policy change without
  explicit organization authorization.

## Approval record

Reviewer must record:

- approval or requested revisions to the rule and outcome schema;
- author/reviewer/activator capability assignments;
- acceptance of separate organization-scoped versions and activation;
- acceptance of the `phase1-v1` equivalence proof;
- approver and decision date.

Until then, this ADR remains proposed and no policy migration or engine work is
authorized.
