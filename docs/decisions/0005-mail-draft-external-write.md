# ADR 0005: Controlled Mail Draft Creation

Status: Accepted and implemented, connector disabled by default  
Date: 2026-07-25

## Context

The first external-write slice must prove that an approved operating-layer
action can cross the provider-neutral execution seam without creating an
external-send capability. Mail is therefore limited to creating an unsent
draft. The source task, approval, preview, second authorization, execution
command, retry state, terminal result, and audit history remain PostgreSQL
facts.

## Decision

Implement one connector capability: Mail `drafts.create`.

- The only OAuth scope declared or used is
  `https://graph.microsoft.com/Mail.ReadWrite`, one of the scopes accepted
  by Google for [`users.drafts.create`](https://developers.google.com/workspace/mail/api/reference/rest/v1/users.drafts/create).
- No `messages.send`/`drafts.send` method, route, or capability exists. The
  code does not request the separate `mail.send`, broader `Mail.Send`, or
  full-mail scopes.
- Configuration is organization-scoped, immutable, versioned, and activated
  through a guarded binding. The absence of a binding means disabled.
- Credential plaintext never enters PostgreSQL, browser state, a prompt, or
  audit metadata. ADR 0006 replaces environment references with an
  application-level RSA/AES envelope; only the dedicated worker role can load
  ciphertext and only the worker environment holds the private decryption key.
- Runtime network execution is separately disabled unless
  `MAIL_DRAFT_NETWORK_ENABLED=true`; no seed or example enables it.

Materialization requires all three gates:

1. the existing recommendation approval is `approved`;
2. the organization’s active Mail-draft config is enabled and its exact
   recipient is allowlisted by address or domain; and
3. a user with `external_actions.authorize` explicitly authorizes the exact
   persisted preview (`to`, `subject`, `body`, and payload hash).

Preview creates no execution command and performs no connector call. Second
authorization creates one immutable Mail execution command and one outbox
event. The worker reloads the preview, authorization, and active connector
version immediately before provider invocation. A disabled or changed binding
creates an immutable abandonment fact and audit event, publishes the external
job without calling Mail, and transactionally returns the workflow to
`approved` so deterministic internal execution remains available.

The external branch is:

```text
approved
  -> awaiting_external_authorization
  -> external_authorized
  -> executing
  -> completed | execution_failed

external_authorized | executing
  -> approved  (guarded kill-switch abandonment only)
```

`transition_workflow()` remains the sole writer of workflow state and the task
status projection. Entry to `executing` requires the matching immutable command;
terminal transition requires the matching immutable result; rollback to
`approved` requires the matching immutable abandonment.

Google describes `mail.compose` as permitting draft management and sending.
There is no draft-create-only OAuth scope. The hard send boundary is therefore
the executor's closed capability set and fixed HTTP transport: its only network
operation is `POST /mail/v1/users/me/drafts`. A leaked connector token could
carry more authority than this application uses, so secret-manager, rotation,
and mailbox controls remain mandatory before enablement.

## Replay and failure semantics

An authorization command is idempotent. The execution command and result are
unique for that organization, approval, and provider. Once a successful result
containing the Outlook draft ID is stored, redelivery publishes the outbox item
without another provider call and returns the same stored result.

Provider failures use the existing PostgreSQL-authoritative attempt count,
bounded retry policy, and dead-letter visibility. Provider output is untrusted:
it must pass the generic execution schema and the Mail-specific
`drafts.create` schema, including the exact rendered payload hash, before
persistence.

As with most third-party create APIs that do not accept a client idempotency
key, a process crash after Mail accepts a request but before PostgreSQL stores
the response is an ambiguous external outcome. Production enablement therefore
requires an operational decision for that crash window; this implementation
does not claim a guarantee that Mail itself does not provide. Stable
redelivery after a stored result is proven to make no second call.

## Audit and isolation

Configuration versions, previews, authorizations, abandonments, execution
commands, and results are organization-scoped and forced through RLS.
Application roles cannot update or delete immutable facts. Audit history
records the connector, `drafts.create` capability, payload hash, authorizer,
resulting draft ID, policy version, and the root trace shared by intake,
approval, preview, authorization, execution, and result.

## Consequences

- A permitted user can create an unsent Outlook draft only after all three gates.
- Disabling the connector before materialization prevents the external call.
- The feature ships inert: no organization is enabled and network transport is
  off by default.
- Mail sending, other Mail mutations, other connectors, ERP/accounting
  writes, live model calls, and Temporal remain outside scope.
