# Phase 2 Permissions Matrix

Status: Implemented role templates; final personnel assignments remain subject
to business approval

These are role templates, not final assignments. Organization membership always limits the rows a role can access. A system administrator does not automatically become a financial approver.

| Capability                         | System admin          | Executive     | Operations manager | Operator       | Approver      | Auditor       |
| ---------------------------------- | --------------------- | ------------- | ------------------ | -------------- | ------------- | ------------- |
| View authorized tasks/sources      | Yes                   | Yes           | Yes                | Yes            | Yes           | Yes           |
| View cross-entity dashboard        | By membership         | By membership | By membership      | No by default  | By membership | By membership |
| Create manual issue                | Yes                   | Yes           | Yes                | Yes            | Yes           | No            |
| Upload controlled CSV batch        | Yes                   | Yes           | Yes                | Yes            | No            | Read only     |
| Edit internal task                 | Yes                   | Yes           | Yes                | Owned/assigned | No by default | No            |
| Run classification/recommendation  | Configure             | Yes           | Yes                | Yes            | Yes           | No            |
| Request approval                   | No by default         | Yes           | Yes                | Yes            | Yes           | No            |
| Approve risk 3/4 action            | No by default         | With grant    | With grant         | No             | With grant    | No            |
| Approve risk 5 action              | Prohibited in Phase 1 | Prohibited    | Prohibited         | Prohibited     | Prohibited    | Prohibited    |
| Execute risk 6 action              | Prohibited            | Prohibited    | Prohibited         | Prohibited     | Prohibited    | Prohibited    |
| Manage users/memberships           | Yes                   | No            | No                 | No             | No            | No            |
| Manage connector secret references | With separate grant   | No            | No                 | No             | No            | No            |
| View connector health              | Yes                   | Yes           | Yes                | Yes            | Yes           | Yes           |
| View audit history                 | Yes                   | Yes           | Yes                | Own scope      | Yes           | Yes           |
| Export audit data                  | With grant            | With grant    | No                 | No             | No            | With grant    |
| Change policy/prompts              | With separate grant   | No            | No                 | No             | No            | Review only   |

## Required separation rules

- A connector service identity cannot approve.
- An agent cannot approve, grant permissions, or change policy.
- Requester/approver separation is enforced when policy requires two people.
- Credential administration and action approval are separate grants.
- User deactivation revokes sessions and blocks new commands.
- Batch approval is absent until exact-target preview and business approval exist.

Controlled CSV upload grants are split into `csv_batches.create` and
`csv_batches.read`. Every grant remains limited by active organization
membership and forced database RLS.

Final grants, approvers, financial materiality thresholds, and emergency access remain unresolved.
