# ADR 0006: Connector Credential and Kill-Switch Hardening

Status: Accepted and implemented; live network execution remains disabled  
Date: 2026-07-25

## Context

Google's `mail.compose` scope is the minimum scope accepted by
`users.drafts.create`, but that token can also authorize sending. OAuth scope
alone therefore cannot be the send boundary. The existing disabled Mail-draft
slice needed an enforceable credential boundary before further connector work.

## Decision

Use application-level hybrid envelope encryption:

- the API receives a token only on the credential-management request;
- it creates a random AES-256-GCM data key, encrypts the token with
  organization/version-bound authenticated data, and wraps the data key with
  an RSA-OAEP-SHA256 public key;
- PostgreSQL stores only ciphertext, nonce, authentication tag, wrapped data
  key, SHA-256 fingerprint, exact scope set, and non-secret metadata;
- the RSA private key is not stored in PostgreSQL and is present only in the
  worker environment;
- the API package exposes only the encryptor; the decryptor is constructed only
  by the worker and loaded only at execution time.

The API login and worker login are separate. Only the
`operating_layer_worker` database role can execute envelope-load/use functions
or select encrypted credential rows. Both roles remain non-owner,
non-superuser, non-`BYPASSRLS`; credential rows use forced organization RLS.

Credential versions and lifecycle events are immutable. Rotation inserts a new
version, atomically moves the guarded active binding, invalidates the prior
version, and queues bounded OAuth revocation. The prior credential immediately
becomes unusable for draft execution; the new credential is available without
downtime. Explicit revoke and organization disable clear the active binding
before queuing revocation.

A global connector-type kill switch serializes with configuration and
credential changes through a transaction advisory lock. Enabling the switch
invalidates every active Outlook credential and queues one OAuth revocation
attempt per credential. Clearing it does not restore credentials; an
organization must provision a new version and explicitly enable its config.

## Scope and capability boundary

The accepted scope allowlist is exactly:

```text
https://graph.microsoft.com/Mail.ReadWrite
```

Broader or additional scopes are rejected by typed validation and a database
constraint. The Mail transport has one method, `createDraft`, fixed to
`POST /mail/v1/users/me/drafts`. There is no send method, route, capability,
or dynamic Mail endpoint. A structural test pins both prototype method sets,
so adding a send method fails verification.

`MAIL_DRAFT_NETWORK_ENABLED` remains `false` by default. Tests perform no
Google network request. OAuth revocation uses the same gate: while disabled,
the credential is already locally unusable and the bounded revocation job
becomes visibly failed/dead-lettered instead of making a hidden call.

## Observability and startup invariants

Enable, disable, rotate, revoke, global kill, credential load/use, revocation
success, and exhausted revocation failure produce immutable hash-chained audit
events with the initiating trace ID. Events contain version IDs, fingerprints,
scope names, purpose, outcome, and reason only—never token plaintext.

Worker startup refuses a database identity outside the dedicated worker role, a
missing/invalid private key, a legacy unsafe credential reference, or an
enabled connector without an active encrypted credential. API startup requires
the public encryption key. Keys and credentials never enable network access.

## Consequences

- A raw database read returns ciphertext, not a usable token.
- Database compromise and worker-key compromise are both needed to decrypt.
- Revocation is best effort at Google; local invalidation is synchronous and
  PostgreSQL-authoritative.
- JavaScript strings cannot be reliably zeroed. Decrypted strings are scoped
  to one execution call, wrapped in a redacting ephemeral object, and never
  persisted or logged.
- Mail sending, other connectors, live model calls, ERP/accounting writes,
  and live connector enablement remain outside this change.
