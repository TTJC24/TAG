# Operational Issue Intake and Resolution

First deployable workflow:

```text
received -> normalized -> classified -> recommended
         -> awaiting_approval -> approved -> action_queued
         -> completed
```

Any active state may move to `blocked`, `failed`, or `cancelled` through an authorized, audited command. Phase 1 actions affect only operating-layer records.

This directory is now the shared Phase 1 domain package used by the API and
worker. PostgreSQL remains authoritative for every transition and job attempt.
