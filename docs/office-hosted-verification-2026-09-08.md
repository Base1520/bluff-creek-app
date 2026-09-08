# Creek Office hosted verification — September 8, 2026

## Actual change

Following Cole's explicit approval of the reviewed seven-migration schema step, the existing Bluff Creek Church Office project (`xzfeumdonxeodqhfirjr`) was rechecked empty and the seven migrations were applied sequentially. All returned success. No additional migration or replay was used.

The connected migration tool assigns its own timestamp versions. Local files and the active manifest now match the actual hosted history. Original versions and exact SQL hashes are retained in [hosted-history-map.json](../tools/office-preflight/hosted-history-map.json). Hosted SHA-256 values were computed from each recorded statement and compared with the approved source bytes. All seven match; each history entry contains one statement. Staff capability revision remains `20260907174301`.

| Migration | Actual recorded version | Source comparison |
| --- | --- | --- |
| office_base | `20260908220558` | Exact approved SHA-256 match |
| membership_care | `20260908220613` | Exact approved SHA-256 match |
| office_content | `20260908220623` | Exact approved SHA-256 match |
| app_connections_care_roles | `20260908220645` | Exact approved SHA-256 match |
| leader_followups | `20260908220658` | Exact approved SHA-256 match |
| office_record_recovery | `20260908220707` | Exact approved SHA-256 match |
| pause_public_app_intake | `20260908220718` | Exact approved SHA-256 match |

## Hosted checks completed

- All 17 expected office tables exist and have row-level security enabled. Anonymous table/column access and PUBLIC table ACL entries are absent.
- All 54 expected office/Storage policy records were inspected. Eight protect the private document bucket, including the restrictive original-source protections. Storage objects have RLS enabled.
- `church-documents` is private, has a 50 MiB file limit and contains no objects.
- All 27 expected application functions exist, with their intended definer/invoker modes, empty search paths and no anonymous/PUBLIC execution. No unexpected nonextension application function was found.
- Both public/private `save_app_connection` entry points deny execution to authenticated browser users as well as anonymous/PUBLIC roles. Existing-profile reads, staff review and readiness remain authenticated-callable under their internal staff/ownership rules.
- Readiness revision, live identity/staff guard, four viewer modules and nine editor modules match the source. Private-schema usage/create privileges match the intended boundary.
- All 17 office tables and Auth users/identities/sessions are empty; Storage object count is zero.
- Hosted security advisor: zero findings. Performance advisor: 24 informational [unindexed foreign keys](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) and 21 informational [unused indexes](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index). These are recorded for workload review; no indexes were added or removed from the empty database.

## What this establishes

The approved office schema is configured on the hosted project. These checks inspect the actual database catalog; they do not establish successful staff login, authenticated HTTP access, uploaded-file behavior, email delivery or operational acceptance.

Two intended administrator identities were supplied privately. No Auth users, staff roles, invitations, sessions, real records or files were created. The last Auth settings response still reports signup allowed and email auto-confirmation off; Auth settings were not changed. The database profile-write pause is independent of Auth signup.

The existing 8810 and 8812 demonstrations remain separate snapshots. The 49-file staged release remains unpublished. No main push, merge, deployment, DNS change, paid-plan change, purchase or outbound message accompanied this step.

## Next acceptance work

1. Complete the reviewed staff access and production email setup, exact hosted recovery callback and signup policy. Match approved email addresses to actual Auth identities before assigning roles. Do not place identities or generated SQL in this repository.
2. Test hosted primary/backup login, first password/reset, expired links, current role removal, private source uploads/downloads and interrupted edits with authorized fictional records.
3. Establish off-device database and original-file backup, then prove recovery to an approved separate destination.
4. Have both operators complete the pilot independently. Keep membership source mapping/import and public release behind their own review gates.

The earlier six-migration local HTTP and restore evidence remains historical. The new seven-migration paused hosted baseline needs its own actual-service acceptance. Do not weaken the historical restore tool to make it accept a different archive contract.
