# ADR 0007: Supervised Gmail draft live pilot

Status: Accepted for operator tooling; first live run remains pending human review

Date: 2026-07-25

## Context

The Gmail draft connector already has a closed `drafts.create` capability,
exact `gmail.compose` scope enforcement, encrypted credential versions,
organization and global kill controls, allowlisted recipients, immutable
previews and authorizations, replay-safe commands, and no send surface. It
ships disabled and automated tests use in-memory transports.

The first real Google call needs an operational control that is narrower than
the general connector configuration: exactly one named organization, exactly
one internal recipient, exactly one supervised draft, and a deterministic
return to the disabled posture. The live call must not be hidden inside CI or
an automated deployment.

## Decision

Add a singleton PostgreSQL live-pilot claim and an operator command with three
operations:

- `enable` claims one named organization, stores one exact-scope encrypted
  credential, enables one exact-address allowlist, and requires every preflight
  check to pass;
- `preflight` returns aggregate, non-secret control evidence; and
- `disable` writes a disabled connector version, synchronously invalidates the
  active credential, releases the claim, and proves the disabled posture.

While a claim is active, application and database guards reject an enabled
configuration for every other organization. Claim/release require the actor to
hold `connectors.admin` for the target and `admin.manage` for every active
organization. This explicit cross-organization permission is required because
the command attests that every other organization is disabled.

The claim is not a replacement for normal entity isolation. It is a narrow
global operating lock used only for the first supervised live draft. Existing
organization-scoped configuration remains unchanged when no claim exists.

Claim state is guarded mutable control state. Claim/release lifecycle facts and
normal connector/audit facts are immutable. The database remains authoritative.
The operator token is read from an environment variable, transmitted only to
the credential-store endpoint, envelope-encrypted by the API, and never
returned by the command. The CLI accepts no credential argument.

The worker network gate remains `false` by default and in CI. A human starts a
single supervised worker with `GMAIL_DRAFT_NETWORK_ENABLED=true` only after:

1. the operator command reports every preflight check true;
2. the exact draft preview has been inspected;
3. the authorization idempotency key and trace ID have been recorded; and
4. no other external command is pending.

The operator then authorizes one immutable preview, verifies one draft in
Gmail and one immutable success audit, replays the same authorization to prove
no second draft is created, disables the pilot, stops the live worker, and
manually discards the draft in Gmail if rollback is required.

## Safety properties

- The only provider target is
  `https://gmail.googleapis.com/gmail/v1/users/me/drafts`.
- The only connector capability is `drafts.create`; there is no send method,
  send route, or dynamic provider endpoint.
- The stored and granted scope sets must both equal
  `https://www.googleapis.com/auth/gmail.compose`.
- The target configuration has one recipient address and no domain allowlist.
- No other organization may be enabled while the pilot claim is active.
- Enable fails closed: after a partial failure it attempts credential
  invalidation/config disable and claim release.
- Disable invalidates local credential use synchronously. Bounded provider
  token revocation is separate and does not delay the local kill.
- The global kill switch remains independently available.
- The live draft is a supervised manual action, never an automated test.

Google does not accept an application idempotency key for `drafts.create`.
The existing ambiguous provider-accepted/database-not-recorded crash window
therefore still exists. The first run is limited to one supervised command;
the operator must check Gmail by exact subject before retrying after an
uncertain network failure.

## Verification

`apps/api/src/gmail-draft.integration.test.ts` case
`enables one named live-pilot organization, proves preflight, and
credential-kills on disable` uses mock transports and a clean PostgreSQL 16
database to prove:

- one-org claim and a second-org enable rejection;
- ciphertext-at-rest, exact scope, one-address allowlist, structural no-send,
  reachable kill controls, and complete preflight;
- out-of-allowlist preview rejection;
- disable plus immediate credential unusability;
- immutable claim/release lifecycle and audit facts; and
- complete cleanup of its own outbox work.

The actual Google draft, mailbox inspection, teardown, and manual rollback are
recorded with the blank evidence template. No real credential or live evidence
is committed.

## Consequences

This creates deliberate operator ceremony around the first call. It does not
enable Gmail by default, add a send capability, broaden scope, add a connector
screen, or authorize more than one live pilot organization. General production
enablement remains a later decision informed by the supervised evidence.
