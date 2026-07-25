# Phase 2 Scope Proposal

Status: Proposed — awaiting slice selection

Date: 2026-07-25

Decision owner: Phase 2 reviewer

## Purpose

Choose exactly one first Phase 2 vertical slice after the two blocking ADRs are
approved. This proposal contains no implementation authorization.

All candidates remain inside the operating layer. They use manual or uploaded
inputs only and add no production connector, source-system read, external
message, live model call, ERP/accounting write, Temporal workflow, or automatic
record merge.

## Entry gates

Implementation may begin only after all of the following are recorded:

1. ADR 0002 selects an idempotency-retention window and accepts its maximum
   legitimate retry assumption.
2. ADR 0003 approves the declarative approval-policy model and change control.
3. The reviewer selects one candidate below.
4. The GitHub `verify` check is an enforced merge gate with a failing-PR proof,
   or the reviewer explicitly records that the repository is single-committer
   and accepts proceeding without branch protection.

The approved retention/reaper and policy-as-data foundations are prerequisites
inside the selected implementation plan, not separate product-scope expansion.

## Ranking

| Rank | Candidate                          | Value                                                                      | Delivery/control risk                                        | Recommendation                                            |
| ---- | ---------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| 1    | Controlled CSV batch intake        | High: converts existing operating spreadsheets into governed tasks         | Medium: batch validation and duplicate semantics             | **Recommended first slice**                               |
| 2    | Internal approval resolution       | Medium-high: completes the human decision loop already surfaced in Phase 1 | Medium-high: separation of duties and N-approver correctness | Strong alternative if governance learning is the priority |
| 3    | Internal issue execution lifecycle | High: tracks ownership through resolution without another source system    | High: expands workflow semantics and concurrent human edits  | Defer until intake and approval foundations are exercised |

Only one candidate should be approved.

## Candidate 1 — Controlled CSV batch intake

### What it delivers

- Authorized upload of one documented CSV template for operational issues.
- Append-only raw file version with checksum, source/ingestion timestamps,
  schema version, retention class, and organization scope.
- Server-side parsing that never evaluates formulas, macros, or embedded
  content.
- Validation preview with accepted, rejected, and duplicate row outcomes before
  task creation.
- Explicit human confirmation of the exact accepted row set.
- Deterministic batch and row idempotency keys.
- Valid confirmed rows enter the existing issue-intake workflow; rejected rows
  create no task.
- Batch status, row-level result references, trace IDs, and audit history.

### Workflow states added

Use a separate `csv_issue_import` workflow:

```text
received
  -> validating
  -> preview_ready
  -> committing
  -> completed
```

Exceptional transitions:

```text
received | validating | preview_ready -> cancelled
received | validating | committing -> failed
validating -> rejected
```

`rejected` means no row passed structural validation. Row outcomes are facts
(`accepted`, `rejected`, `duplicate`) rather than workflow states. Confirmed
accepted rows create existing issue workflows at `received`.

### Acceptance criteria

- A user with `csv_import:create` and organization access can upload only for
  that organization; application authorization and direct database RLS tests
  deny cross-organization access.
- The original bytes are stored once as an immutable source version before
  validation results are committed.
- Unsupported encoding, columns, size, row count, field values, and ambiguous
  organization fail closed with row/file-specific errors.
- Preview creates no tasks and shows the exact normalized values and resulting
  policy effect for each valid row.
- Confirmation binds to the preview hash; changing the file or normalized rows
  requires a new preview.
- The same live batch/row idempotency keys replay prior results; conflicting
  payloads are rejected; after the approved expiry they are explicitly new
  intents.
- Confirmed valid rows create exactly one task each and traverse the existing
  typed classifier/recommendation/approval path.
- Every resulting approval decision stamps the immutable policy-version ID and
  content hash.
- A partial process failure is safely retryable and cannot duplicate already
  committed rows.
- Batch and row results, failures, counts, source citations, trace propagation,
  and audit events are visible without a new external system.
- Feature tests cover clean import, mixed valid/invalid rows, malformed file,
  duplicate retry before expiry, retry after expiry, policy-version pinning,
  interrupted commit, and cross-organization denial.

### Deliberately excluded

- XLS/XLSX, macros, formulas, images, archives, and arbitrary template mapping.
- Scheduled folder watching or email attachment ingestion.
- Acumatica, Pipedrive, Gmail, Drive, or other connector reads.
- Automatic customer/vendor/order matching or duplicate merging.
- Cross-organization files or one batch that creates work in multiple
  organizations.
- External messages, source-system updates, or financial actions.

### Dependency on the blocking decisions

- **Idempotency retention:** batch and row claims use the approved window. The
  preview must warn that an identical retry after expiry is a new intent and
  may duplicate work; similarity detection cannot silently merge it.
- **Approval policy:** both the import command and every generated task use the
  pinned declarative policy version. The batch may not cache an unstamped
  `phase1-v1` code decision.

### Why ranked first

It adds the deferred input channel users already have—spreadsheets—while
reusing the proven issue workflow, queue, detail, audit, RLS, and deterministic
agent paths. It creates no external integration boundary and provides direct
evidence that retention and policy versioning work under batch retry.

## Candidate 2 — Internal approval resolution

### What it delivers

- Authorized human approve, reject, cancel, and expiry decisions for pending
  internal recommendations.
- Exact payload preview and hash binding.
- One- and N-approver collection with requester/approver and
  approver/approver separation.
- In-app status/history updates only; approval never invokes an external
  action.

### Workflow states added

Extend the issue workflow approval branch:

```text
awaiting_approval
  -> partially_approved
  -> approved
  -> completed
```

Alternative terminal decisions:

```text
awaiting_approval | partially_approved -> rejected
awaiting_approval | partially_approved -> expired
awaiting_approval | partially_approved -> cancelled
```

`partially_approved` is reachable only for a pinned
`requires_n_approvers` outcome. `approved` records that the internal
recommendation was authorized; it queues no external action.

### Acceptance criteria

- Only an organization-scoped user with the policy-required approval
  permission may decide.
- Requester and approver are distinct when required; N approvals come from N
  distinct eligible users.
- Every decision is bound to the task/workflow, exact payload hash, and pinned
  immutable policy version.
- A policy activation during a pending approval does not reinterpret it;
  explicit re-evaluation is separately authorized and audited.
- Duplicate commands within the approved retention window replay the original
  decision and cannot count an approver twice.
- Direct approval/status writes and illegal transitions are rejected by the
  database.
- Reject, expiry, and cancellation remain visible in the executive queue and
  task history.
- Every request and decision emits immutable audit events with one trace ID.
- Feature tests cover one approver, N approvers, duplicate approval,
  self-approval denial, wrong organization, wrong permission, stale payload,
  policy change while pending, rejection, and expiry.

### Deliberately excluded

- Action execution after approval.
- Email or chat approval links and notifications.
- Batch approvals, delegated approvals, emergency override, and mobile signing.
- Risk-5/6 enablement; both remain blocked exactly as in Phase 1.
- Payments, journals, customer/vendor masters, CRM updates, or external sends.

### Dependency on the blocking decisions

- **Idempotency retention:** approve/reject commands and individual approver
  facts need the selected replay window so retries cannot double-count.
- **Approval policy:** this slice directly depends on immutable rule versions,
  approver counts, permission requirements, and separation constraints. The
  `phase1-v1` equivalence proof must pass before activation.

### Why ranked second

It proves the strongest governance mechanism before any write capability, but
it adds less immediate operational input value than CSV and requires more
authorization/state-transition design.

## Candidate 3 — Internal issue execution lifecycle

### What it delivers

- A linked internal execution workflow for assigning an owner, setting a due
  date, starting work, recording a blocker, resolving, and closing an issue.
- Queue projections for current owner, aging, blocked reason, and resolution
  evidence.
- Idempotent, audited human commands with optimistic versions.

### Workflow states added

Create a separate `internal_issue_execution` workflow so the proven intake
workflow remains unchanged:

```text
planned
  -> assigned
  -> in_progress
  -> resolved
  -> closed
```

Blocker loop and cancellation:

```text
assigned | in_progress -> blocked
blocked -> in_progress
planned | assigned | in_progress | blocked -> cancelled
```

The task's visible execution status is a guarded projection of this workflow,
updated in the same database transaction.

### Acceptance criteria

- Authorized users can create the execution workflow only for an existing task
  in their organization.
- Owner, due date, blocker, and resolution changes occur only through
  database-enforced transitions with optimistic versions.
- A task cannot be closed without resolution evidence; a blocked task requires
  a reason and owner.
- Direct projection writes and cross-organization reads/writes are rejected.
- Duplicate transition commands replay the original result during the approved
  retention window.
- Each command evaluates and stamps the active immutable policy version; a
  blocked policy outcome prevents the transition.
- Queue counts and task history reflect assignment, overdue, blocked, resolved,
  and closed states without drift.
- Feature tests cover legal/illegal transitions, competing updates, reassigned
  owner, blocker loop, closure prerequisites, idempotency, policy pinning, RLS,
  projection drift, and audit/trace continuity.

### Deliberately excluded

- Email/chat notifications, calendar events, reminders sent outside the app,
  and external task-system synchronization.
- Automated owner assignment, SLA/escalation policy, recurring tasks, and
  cross-organization execution workflows.
- Connector reads/writes, live agents, and source-system status updates.
- Approval of financial or external actions.

### Dependency on the blocking decisions

- **Idempotency retention:** every human transition command uses the approved
  window; an expired retry is a new transition intent and must still satisfy
  the current expected workflow version.
- **Approval policy:** internal transition effects are evaluated by the one
  declarative evaluator and pinned to a version. No transition rule is hidden
  in a prompt or duplicated as an approval rule.

### Why ranked third

It has high operational value, but it introduces a second long-lived workflow,
human concurrency, mutable projections, and lifecycle semantics before the
batch-ingestion and approval foundations have been exercised.

## Reviewer selection record

Record exactly one:

- [ ] Candidate 1 — Controlled CSV batch intake (**recommended**)
- [ ] Candidate 2 — Internal approval resolution
- [ ] Candidate 3 — Internal issue execution lifecycle
- [ ] None; request a revised proposal

Also record:

- selected candidate and rationale;
- accepted exclusions or requested changes;
- confirmation that ADRs 0002 and 0003 are accepted;
- CI merge-gate status, or explicit single-committer exception;
- approver and decision date.

No Phase 2 implementation begins from this proposal alone.
