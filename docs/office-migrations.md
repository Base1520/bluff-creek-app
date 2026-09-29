# Creek Office migration preparation

**Current setup — September 10:** the active format-4 manifest requires ten migrations. The account guard remains at recorded version `20260909124122`; direct guest/prayer intake and dispatcher extensions were applied as `20260910152017` and `20260910152030`, with exact approved SQL bytes. Verify all ten recorded versions on the existing church project without replay. See the [current history map](../tools/office-preflight/direct-intake-hosted-history-2026-09-10.json), [direct-intake contract](../tools/direct-intake/README.md) and [staff guard record](office-account-guard-hosted-2026-09-09.md). Published PR #7 enables the new authenticated guest/prayer flow with email/password accounts and no email-confirmation requirement; email addresses are self-reported, and this grants no staff access or church membership. Blank configuration in the development source is a release placeholder, not the published configuration. Original SQL hashes, maps and dated results below retain their historical scope.

September 8, 2026. **Local filenames now match the seven versions recorded during the authorized hosted application.** All seven SQL byte hashes and the capability revision remain unchanged. See the current hosted-history alignment appended below; earlier preparation and rehearsal evidence retains its original filenames and scope.

The earlier packet had two migrations with the same eight-digit version, and its base schema lived outside the directory consumed by the migration tool. An automatic run could skip that foundation or encounter conflicting versions. The repaired baseline contains six unique, ascending 14-digit filenames in `supabase/migrations`, created with the official Supabase CLI 2.117.0 `migration new` command. They preserve the existing six-step dependency order.

All six baseline SQL files remain **byte-for-byte identical** to the prior packet. The original SHA-256 values were checked before and after the move and retained in `tools/office-preflight/manifest.json` and `migration-history-map.json`. The original filename repair changed no policies, grants, tables, functions, seed records or staff permissions. The separate seventh migration below intentionally narrows submission privileges. The client/schema capability revision remains `20260907174301`; it is not the new file timestamp. Historical filename comments in the SQL are retained; use this mapping and the current manifest for paths.

## Historical preparation mapping

| Previous path | Prepared filename before hosted application |
| --- | --- |
| `supabase/schema.sql` | `supabase/migrations/20260907231507_office_base.sql` |
| `supabase/migrations/20260907_membership_care.sql` | `supabase/migrations/20260907231527_membership_care.sql` |
| `supabase/migrations/20260907_office_content.sql` | `supabase/migrations/20260907231528_office_content.sql` |
| `supabase/migrations/20260907164733_app_connections_care_roles.sql` | `supabase/migrations/20260907231530_app_connections_care_roles.sql` |
| `supabase/migrations/20260907171014_leader_followups.sql` | `supabase/migrations/20260907231531_leader_followups.sql` |
| `supabase/migrations/20260907174301_office_record_recovery.sql` | `supabase/migrations/20260907231533_office_record_recovery.sql` |

## Historical seventh migration: pause the old profile entry points

`supabase/migrations/20260908193401_pause_public_app_intake.sql` was generated with Supabase CLI 2.117.0 `migration new pause_public_app_intake`. Its only SQL operation is a transaction revoking EXECUTE on both `public.save_app_connection(text,text,text,text,boolean,text)` and `private.save_app_connection(text,text,text,text,boolean,text)` from PUBLIC, anon and authenticated. This blocks new profiles and updates from every browser caller, including signed-in staff. Revoking both closes direct access to the private SECURITY DEFINER helper as well as its public SECURITY INVOKER wrapper.

Existing own-profile reads and authorized staff review remain available; review can still link an existing pending profile or create a visitor and welcome plan. Records, function bodies, table policies and the original six migration bytes are unchanged. The capability revision stays `20260907174301` because the office's staff review/read API remains intact. That readiness value alone does not confirm the pause: verify the seventh tracked version and both actual function grants separately during hosted acceptance.

This pause is narrower than disabling Auth signup. It does not change account creation, sign-in, email settings, owner/service access, or public-page configuration. Keep the public connection page blank for a staff-first pilot. Reopening submission requires a separately reviewed tracked migration, explicit rollout instruction and hosted tests; there is no UI toggle or automatic grant.

## Current source verification

Run `node tools/office-preflight/cli.mjs` and `node --test tools/office-preflight/preflight.test.mjs` from the app root. Manifest format 4 requires the base migration first, all ten migrations in the inventory, unique timestamps, and ascending filenames matching declared dependencies. Unreviewed files, missing files, changed SQL, duplicate versions and out-of-order versions fail. The manifest explicitly identifies the sixth readiness source, seventh old-intake pause, eighth staff guard, ninth direct-intake source and tenth dispatcher-extension source. The approved guard and both new SQL hashes are independently pinned; a refreshed manifest digest cannot bless changed SQL. Both old `save_app_connection` entry points remain revoked; the new authenticated RPCs provide guest/prayer submission. The extensions alone create no schedule or secret. This checker remains read-only, local and credential-redacting.

September 10 source-alignment verification passed 28/28 focused preflight tests, the ten-migration local preflight, and 112/112 selected preflight, wiring, access, direct-intake and historical pause tests. The former eight-file manifest is frozen for tests that specifically cover that baseline; the direct-intake suite applies those eight plus the functional SQL once. These local results do not prove live Auth, email delivery, phone behavior or scheduler operation.

Historical September 9 verification passed 23/23 preflight tests and 45/45 local checks. The complete eight-file SQL test passed six checks covering unchanged records/readiness, both denied submission paths for anonymous/member/staff callers, PUBLIC inheritance, isolated existing-profile reads and preserved editor/admin review. These used fictional in-memory PostgreSQL only.

Historical September 7 verification: the six-file preflight passed 16/16 tests and 39/39 local checks. The SQL regression suite in `admin/tests` now uses the new paths and passes 51/51 checks, executing the complete SQL with synthetic records in PGlite. This checks PostgreSQL behavior and the existing role/recovery matrix. It does not replace a clean rehearsal on a Supabase local stack or the hosted Auth/Storage/advisor checks. The initial full staff run stalled because macOS had offloaded a jsdom dependency file. Restoring the exact locked packages with npm ci --ignore-scripts resolved the import. A subsequent run exposed a fixed-delay assumption in the first session test; its setup now waits for the rendered record with a two-second bound, preserving all immediate logout/privacy assertions. The targeted session suite passes 28/28 and the complete staff suite now passes 183/183 under Node 24.19.0. Package and lockfile hashes are unchanged. These fresh local results do not establish hosted service behavior.

## Historical checklist before the first hosted application

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

## Historical hosted-history alignment — September 8, 2026

The authorized application used the connected Supabase migration tool, which recorded the versions below. The recorded versions were read back from hosted history. Each recorded statement SHA-256 was separately compared with the approved source, and all seven match exactly. See [hosted verification](office-hosted-verification-2026-09-08.md). The local CLI was not signed in; no remote migration-history repair, replay or hosted SQL action was performed by this alignment.

| Approved filename before application | Current tracked filename / recorded version |
| --- | --- |
| `20260907231507_office_base.sql` | `20260908220558_office_base.sql` |
| `20260907231527_membership_care.sql` | `20260908220613_membership_care.sql` |
| `20260907231528_office_content.sql` | `20260908220623_office_content.sql` |
| `20260907231530_app_connections_care_roles.sql` | `20260908220645_app_connections_care_roles.sql` |
| `20260907231531_leader_followups.sql` | `20260908220658_leader_followups.sql` |
| `20260907231533_office_record_recovery.sql` | `20260908220707_office_record_recovery.sql` |
| `20260908193401_pause_public_app_intake.sql` | `20260908220718_pause_public_app_intake.sql` |

All paths above are inside `supabase/migrations/`. Each file was hashed before and after the local rename against its approved manifest SHA-256. All seven matched exactly. Order and dependencies are unchanged; `office_readiness` still declares capability revision `20260907174301`. The current manifest, runnable SQL tests and setup references use the recorded versions. This is filename alignment to existing hosted history, not a new SQL change or permission change.

After alignment, the focused preflight suite passed 19/19 tests, the current packet passed 43/43 local checks with seven migrations, and all SQL suites passed 57/57 tests using the new paths. These are fresh local checks; no hosted statement, role, storage or email check was performed by the filename-alignment work.

The machine-readable [hosted history map](../tools/office-preflight/hosted-history-map.json) preserves each old approved path, current path, recorded version and expected SQL SHA-256. The earlier six-file [preparation map](../tools/office-preflight/migration-history-map.json) remains unchanged, providing the preceding provenance step. Dated local rehearsal/restore evidence is not relabeled: the older six-file service and restore checks still describe their original baseline. The fixed historical restore runner does not establish recovery acceptance for this current seven-version hosted baseline.

Do not replay the old filenames or mark remote history repaired to make a local listing agree. Before any later migration, compare the current tracked list and hosted history, then review the new pending change. Hosted role/storage/intake grants, Auth settings, staff provisioning, backups, delivery and acceptance remain separate checks; a local hash match does not verify them.
