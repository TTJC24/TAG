# Outlook adapter

Status: disabled. The only implemented capability is unsent
`users.drafts.create`; no send method or route exists.

Credential plaintext is envelope-encrypted before persistence. The API holds
only the public encryption key; only the dedicated worker role may load an
organization-scoped envelope, and only the worker environment holds the private
key. Accepted OAuth scope is exactly `Mail.ReadWrite`; broader scopes fail
closed. Organization disable, explicit revoke, rotation, and the global Outlook
kill switch synchronously invalidate local use and queue bounded OAuth
revocation.

Live Outlook and OAuth-revocation network calls remain disabled by default.

The first supervised live draft uses the guarded
`pnpm mail-draft:pilot` operator command and ADR 0007. An enable operation:

1. claims exactly one named organization in PostgreSQL;
2. stores one credential from `MAIL_DRAFT_OAUTH_ACCESS_TOKEN`;
3. enables one exact internal recipient address with no domain allowlist; and
4. fails unless the aggregate, non-secret preflight proves ciphertext,
   exact scope, one-org isolation, reachable kill controls, and structural
   no-send.

The matching disable operation first writes a disabled connector version,
synchronously invalidates the credential, releases the pilot claim, and
verifies the disabled-by-default posture. The global kill remains independent.
Automated tests use only mock transports. The live Google call is an attended
manual run under `docs/runbook.md`; no credential or live evidence is committed.
