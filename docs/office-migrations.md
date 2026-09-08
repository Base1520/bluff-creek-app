# Creek Office migration preparation

September 8, 2026. **Seven-file staff-first setup packet prepared; no hosted SQL applied.**

The earlier packet had two migrations with the same eight-digit version, and its base schema lived outside the directory consumed by the migration tool. An automatic run could skip that foundation or encounter conflicting versions. The repaired baseline contains six unique, ascending 14-digit filenames in `supabase/migrations`, created with the official Supabase CLI 2.117.0 `migration new` command. They preserve the existing six-step dependency order.

All six baseline SQL files remain **byte-for-byte identical** to the prior packet. The original SHA-256 values were checked before and after the move and retained in `tools/office-preflight/manifest.json` and `migration-history-map.json`. The original filename repair changed no policies, grants, tables, functions, seed records or staff permissions. The separate seventh migration below intentionally narrows submission privileges. The client/schema capability revision remains `20260907174301`; it is not the new file timestamp. Historical filename comments in the SQL are retained; use this mapping and the current manifest for paths.

## File mapping

| Previous path | Current tracked migration |
| --- | --- |
| `supabase/schema.sql` | `supabase/migrations/20260907231507_office_base.sql` |
| `supabase/migrations/20260907_membership_care.sql` | `supabase/migrations/20260907231527_membership_care.sql` |
| `supabase/migrations/20260907_office_content.sql` | `supabase/migrations/20260907231528_office_content.sql` |
| `supabase/migrations/20260907164733_app_connections_care_roles.sql` | `supabase/migrations/20260907231530_app_connections_care_roles.sql` |
| `supabase/migrations/20260907171014_leader_followups.sql` | `supabase/migrations/20260907231531_leader_followups.sql` |
| `supabase/migrations/20260907174301_office_record_recovery.sql` | `supabase/migrations/20260907231533_office_record_recovery.sql` |

## Seventh migration: pause public profile intake

`supabase/migrations/20260908193401_pause_public_app_intake.sql` was generated with Supabase CLI 2.117.0 `migration new pause_public_app_intake`. Its only SQL operation is a transaction revoking EXECUTE on both `public.save_app_connection(text,text,text,text,boolean,text)` and `private.save_app_connection(text,text,text,text,boolean,text)` from PUBLIC, anon and authenticated. This blocks new profiles and updates from every browser caller, including signed-in staff. Revoking both closes direct access to the private SECURITY DEFINER helper as well as its public SECURITY INVOKER wrapper.

Existing own-profile reads and authorized staff review remain available; review can still link an existing pending profile or create a visitor and welcome plan. Records, function bodies, table policies and the original six migration bytes are unchanged. The capability revision stays `20260907174301` because the office's staff review/read API remains intact. That readiness value alone does not confirm the pause: verify the seventh tracked version and both actual function grants separately during hosted acceptance.

This pause is narrower than disabling Auth signup. It does not change account creation, sign-in, email settings, owner/service access, or public-page configuration. Keep the public connection page blank for a staff-first pilot. Reopening submission requires a separately reviewed tracked migration, explicit rollout instruction and hosted tests; there is no UI toggle or automatic grant.

## Verification

Run `node tools/office-preflight/cli.mjs` and `node --test tools/office-preflight/preflight.test.mjs` from the app root. Manifest format 2 requires the base migration first, all seven migrations in the inventory, unique timestamps, and ascending filenames matching declared dependencies. Unreviewed files, missing files, changed SQL, duplicate versions and out-of-order versions fail. The manifest explicitly identifies the sixth readiness source and seventh pause source. The checker rejects a missing pause, omitted signature or added grant even if a local digest was refreshed. This checker remains read-only, local and credential-redacting.

Current preflight verification passes 19/19 tests and 43/43 local checks. The complete seven-file SQL test passes six checks covering unchanged records/readiness, both denied submission paths for anonymous/member/staff callers, PUBLIC inheritance, isolated existing-profile reads and preserved editor/admin review. These use fictional in-memory PostgreSQL only.

Historical September 7 verification: the six-file preflight passed 16/16 tests and 39/39 local checks. The SQL regression suite in `admin/tests` now uses the new paths and passes 51/51 checks, executing the complete SQL with synthetic records in PGlite. This checks PostgreSQL behavior and the existing role/recovery matrix. It does not replace a clean rehearsal on a Supabase local stack or the hosted Auth/Storage/advisor checks. The initial full staff run stalled because macOS had offloaded a jsdom dependency file. Restoring the exact locked packages with npm ci --ignore-scripts resolved the import. A subsequent run exposed a fixed-delay assumption in the first session test; its setup now waits for the rendered record with a two-second bound, preserving all immediate logout/privacy assertions. The targeted session suite passes 28/28 and the complete staff suite now passes 183/183 under Node 24.19.0. Package and lockfile hashes are unchanged. These fresh local results do not establish hosted service behavior.

## Before the first hosted application

The [local stack guide](../tools/office-local-stack/README.md) now provides a separate, unlinked rehearsal directory, verified migration copying and a loopback-only browser preview. The [HTTP rehearsal](../tools/office-rehearsal/README.md) uses fictional users and actual Auth/REST/Storage services, refuses hosted targets and keeps privileged keys in memory. Its guard tests establish safe tool behavior; only a recorded real service run establishes a local service pass. Production browser configs remain blank.

1. Get the concrete activation instruction for the dedicated Bluff Creek Church Office project (`xzfeumdonxeodqhfirjr`). The prior project-creation approval did not activate the office or invite staff.
2. Recheck that this is the intended target and that public office objects, staff users/files and migration history are still empty. The September 7 creation check is dated evidence, not a lock against later work. If old schema or history exists, stop and reconcile it; do not blindly mark new IDs applied or replay the renamed baseline.
3. Review the exact committed manifest, byte hashes and seven-file pending list. Rehearse on a clean local Supabase stack and review its database advisors; then use the authorized tracked migration mechanism for the target. Do not use SQL Editor changes that bypass history. Local filename normalization is not remote history repair.
4. For CLI 2.117.0, inspect `migration list --help` and `db push --help` first. Use an explicit verified target. Its `db push` supports `--dry-run`; review that pending list before applying. The CLI also documents `--skip-vault`: include it so an office migration does not synchronize unrelated Vault configuration. No push/list/link command was executed against a hosted or local Supabase database during this preparation.
5. After application, verify all seven tracked versions, `office_readiness()`, both denied submission EXECUTE grants, retained own-read/staff-review grants and RLS, then run hosted advisors and the fictional permission/storage/recovery rehearsal. A configured project is still not an accepted office pilot. Staff creation, public app signup, redirects, email delivery, backups and real records retain their separate approval and verification steps.

No automatic deployment workflow, account connection, secret, staff seed, migration repair command or apply script is added here.

## Source checks

Current [Supabase migration documentation](https://supabase.com/docs/guides/deployment/database-migrations) describes timestamp-ordered migrations and history reconciliation. Official CLI 2.117.0 archive/checksum verification and local help were captured in this task's tool-setup evidence. The launcher uses its supported `SUPABASE_HOME` override to keep tool state under this task's work directory; no global installation is needed.

The current changelog was reviewed. [Explicit Data API grants](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) remain required independently of RLS; the existing migrations already declare grants/revokes. The base uses unversioned `create extension if not exists pgcrypto`, so the [extension-version change](https://supabase.com/changelog/extension-version-pinning-ignored) requires no SQL alteration. The historical path-only change did not modify authorization semantics. The seventh migration intentionally revokes profile-submission privileges; no local check certifies eventual hosted configuration.
