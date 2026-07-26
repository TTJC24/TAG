# Gmail draft live-pilot evidence

Do not record OAuth tokens, authorization headers, private keys, or other
credentials in this file. Complete this copy outside source control unless the
approved evidence store is explicitly designated.

## Run identity

- Date/time (UTC):
- Operator:
- Independent observer:
- Environment:
- Release commit:
- Target organization name:
- Target organization code:
- Target organization ID:
- Single internal recipient:
- Change/ticket reference:

## Preflight

- Operator operation ID:
- Operator trace ID:
- Pilot claim version:
- Connector config version ID:
- Credential version ID:
- Credential fingerprint (SHA-256 only):
- [ ] Pilot is claimed for the target organization.
- [ ] Target connector is enabled.
- [ ] Every other organization is disabled.
- [ ] Credential envelope is present and structurally valid.
- [ ] Stored and granted scopes are exactly `gmail.compose`.
- [ ] Allowlist contains one exact address and no domains.
- [ ] Expected recipient is allowlisted.
- [ ] Global kill is clear and reachable.
- [ ] Structural no-send check passes.
- [ ] Preflight reports `readyForLiveDraft: true`.
- Preflight output evidence reference:

## Preview and authorization

- Task ID:
- Workflow ID:
- Approval ID:
- Preview ID:
- Preview payload hash:
- Expected recipient:
- Expected subject:
- Expected body evidence reference:
- Root trace ID:
- Authorization idempotency key:
- Authorization ID:
- External execution command ID:
- Outbox event ID:
- [ ] Exact preview was inspected before authorization.
- [ ] No other external command was pending before authorization.
- [ ] Only one network-enabled worker was running.

## Google result

- Gmail draft ID:
- Immutable `gmail_draft.created` audit event ID:
- Audit event hash:
- Audit chain verification result/reference:
- Provider response evidence reference:
- [ ] Exactly one matching draft appeared in Gmail.
- [ ] Recipient, subject, and body matched the immutable preview.
- [ ] No message was sent.
- [ ] Intake/approval/preview/authorization/worker/audit trace IDs match.
- [ ] Repeating the same authorization idempotency key replayed the prior
      result.
- [ ] Repeating authorization created no second Gmail draft.

## Secret-containment review

- Log/trace query time range:
- Systems searched:
- Search method/evidence reference:
- [ ] OAuth token does not appear in API logs.
- [ ] OAuth token does not appear in worker logs.
- [ ] OAuth token does not appear in traces or audit metadata.
- [ ] OAuth token does not appear in command output or shell history.
- Reviewer:

## Teardown

- Disable operation ID:
- Disable trace ID:
- Connector disabled at (UTC):
- Credential invalidated at (UTC):
- Revocation job/result reference:
- Pilot release claim version:
- [ ] Disable reports `disabledByDefault: true`.
- [ ] Target connector is disabled.
- [ ] No active credential version remains.
- [ ] Previously active credential is unusable locally.
- [ ] Live worker was stopped.
- [ ] `GMAIL_DRAFT_NETWORK_ENABLED` was removed/restored to false.
- [ ] Token and key environment variables were removed from the operator
      shell.

## Rollback

- Rollback required?:
- Gmail draft discarded at (UTC):
- Gmail account used:
- Observer:
- [ ] Draft ID/subject matched before discard.
- [ ] Draft no longer appears in Gmail Drafts.
- [ ] Nothing was sent, so no recipient-side compensation was required.

## Exceptions and sign-off

- Deviations:
- Incidents or ambiguous provider outcomes:
- Follow-up actions:
- Operator sign-off:
- Reviewer sign-off:
