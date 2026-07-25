# Source-System Inventory

Status: Discovery baseline
Date: 2026-07-25

No production connector schema or credential has been supplied.

| Source                                   | Entities                  | Authority                          | Phase 1                       | Required discovery                                                                                 |
| ---------------------------------------- | ------------------------- | ---------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Manual issue intake                      | All                       | Operating-layer task input         | Included                      | Required fields, allowed creators, ownership rules                                                 |
| CSV upload                               | All                       | Import-specific; never master data | Included                      | Approved templates, identifier mapping, row limits                                                 |
| Acumatica                                | BLCS, FSI, USA migration  | ERP/accounting/operations source   | Placeholder, read-only later  | Version, endpoints, tenants, companies/branches, objects, customizations, rate limits, read scopes |
| Pipedrive                                | To confirm                | CRM candidate                      | Placeholder, read-only later  | Authority decision, pipelines, stages, custom fields, activity types, ownership                    |
| Gmail / Google Workspace                 | To confirm                | Communication source               | Placeholder, read-only later  | Domain, mailboxes, delegation, labels, OAuth scopes, retention, sensitive-data rules               |
| Google Drive                             | To confirm                | Document source candidate          | Placeholder, read-only later  | Shared drives/folders, ACL inheritance, formats, authoritative locations, retention                |
| Uploaded files/reports                   | All                       | Contextual input                   | Metadata/raw storage included | File types, size limits, malware scanning, retention                                               |
| Media storage/editing/social             | Cultivus+                 | Production/source/delivery systems | Not in Phase 1                | Platforms, asset IDs, stages, reviewers, delivery controls                                         |
| Banking/payment/accounting write systems | Relevant finance entities | Financial systems of record        | Prohibited                    | Not eligible for MVP discovery-to-write path                                                       |

## Inventory rules

- Each configured instance becomes an organization-scoped `source_system`.
- Credentials are separate by environment, source, entity/company/branch, and read/write capability.
- Source URLs and external IDs are preserved.
- Raw payload versions are immutable.
- The system must record cursor, freshness, health, redacted errors, and last successful sync.
- No adapter implementation begins from guessed fields or undocumented source semantics.
