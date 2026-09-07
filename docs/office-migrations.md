# Creek Office migration preparation

September 7, 2026. **Local setup sequence repaired; no hosted SQL applied.**

The earlier packet had two migrations with the same eight-digit version, and its base schema lived outside the directory consumed by the migration tool. An automatic run could skip that foundation or encounter conflicting versions. The packet now contains six unique, ascending 14-digit filenames in `supabase/migrations`, created with the official Supabase CLI 2.117.0 `migration new` command. They preserve the existing six-step dependency order.

All six SQL files are **byte-for-byte identical** to the prior packet. The original SHA-256 values were checked before and after the move and retained in `tools/office-preflight/manifest.json` and `migration-history-map.json`. No policies, grants, tables, functions, seed records or staff permissions were changed. The client/schema capability revision remains `20260907174301`; it is not the new file timestamp. Historical filename comments in the SQL are retained; use this mapping and the current manifest for paths.

## File mapping

| Previous path | Current tracked migration |
| --- | --- |
| `supabase/schema.sql` | `supabase/migrations/20260907231507_office_base.sql` |
| `supabase/migrations/20260907_membership_care.sql` | `supabase/migrations/20260907231527_membership_care.sql` |
| `supabase/migrations/20260907_office_content.sql` | `supabase/migrations/20260907231528_office_content.sql` |
| `supabase/migrations/20260907164733_app_connections_care_roles.sql` | `supabase/migrations/20260907231530_app_connections_care_roles.sql` |
| `supabase/migrations/20260907171014_leader_followups.sql` | `supabase/migrations/20260907231531_leader_followups.sql` |
| `supabase/migrations/20260907174301_office_record_recovery.sql` | `supabase/migrations/20260907231533_office_record_recovery.sql` |

## Verification

Run `node tools/office-preflight/cli.mjs` and `node --test tools/office-preflight/preflight.test.mjs` from the app root. Manifest format 2 requires the base migration first, all six migrations in the inventory, unique timestamps, and ascending filenames matching declared dependencies. Unreviewed files, missing files, changed SQL, duplicate versions and out-of-order versions fail. This checker remains read-only, local and credential-redacting.

The preflight passes 16/16 tests and 39/39 local checks. The SQL regression suite in `admin/tests` now uses the new paths and passes 51/51 checks, executing the complete SQL with synthetic records in PGlite. This checks PostgreSQL behavior and the existing role/recovery matrix. It does not replace a clean rehearsal on a Supabase local stack or the hosted Auth/Storage/advisor checks. The attempted full staff suite stalled after its initial output and was interrupted; no new 183-test full-suite pass is claimed. The unchanged UI tests are being diagnosed separately. The previous 183-test result remains dated evidence, not this migration-path verification.

## Before the first hosted application

1. Get the concrete activation instruction for the dedicated Bluff Creek Church Office project (`xzfeumdonxeodqhfirjr`). The prior project-creation approval did not activate the office or invite staff.
2. Recheck that this is the intended target and that public office objects, staff users/files and migration history are still empty. The September 7 creation check is dated evidence, not a lock against later work. If old schema or history exists, stop and reconcile it; do not blindly mark new IDs applied or replay the renamed baseline.
3. Review the exact committed manifest, byte hashes and six-file pending list. Rehearse on a clean local Supabase stack and review its database advisors; then use the authorized tracked migration mechanism for the target. Do not use SQL Editor changes that bypass history. Local filename normalization is not remote history repair.
4. For CLI 2.117.0, inspect `migration list --help` and `db push --help` first. Use an explicit verified target. Its `db push` supports `--dry-run`; review that pending list before applying. The CLI also documents `--skip-vault`: include it so an office migration does not synchronize unrelated Vault configuration. No push/list/link command was executed against a hosted or local Supabase database during this preparation.
5. After application, verify all six tracked versions, `office_readiness()`, grants and RLS, then run hosted advisors and the fictional permission/storage/recovery rehearsal. A configured project is still not an accepted office pilot. Staff creation, public app signup, redirects, email delivery, backups and real records retain their separate approval and verification steps.

No automatic deployment workflow, account connection, secret, staff seed, migration repair command or apply script is added here.

## Source checks

Current [Supabase migration documentation](https://supabase.com/docs/guides/deployment/database-migrations) describes timestamp-ordered migrations and history reconciliation. Official CLI 2.117.0 archive/checksum verification and local help were captured in this task's tool-setup evidence. The launcher uses its supported `SUPABASE_HOME` override to keep tool state under this task's work directory; no global installation is needed.

The current changelog was reviewed. [Explicit Data API grants](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) remain required independently of RLS; the existing migrations already declare grants/revokes. The base uses unversioned `create extension if not exists pgcrypto`, so the [extension-version change](https://supabase.com/changelog/extension-version-pinning-ignored) requires no SQL alteration. This path-only change does not modify authorization semantics or certify the eventual hosted configuration.
