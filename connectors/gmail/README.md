# Gmail adapter

Status: disabled. The only implemented capability is unsent
`users.drafts.create`; no send method or route exists.

Credential plaintext is envelope-encrypted before persistence. The API holds
only the public encryption key; only the dedicated worker role may load an
organization-scoped envelope, and only the worker environment holds the private
key. Accepted OAuth scope is exactly `gmail.compose`; broader scopes fail
closed. Organization disable, explicit revoke, rotation, and the global Gmail
kill switch synchronously invalidate local use and queue bounded OAuth
revocation.

Live Gmail and OAuth-revocation network calls remain disabled by default.
