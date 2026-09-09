# Staff account guard — hosted application and source alignment

September 9, 2026. After the user explicitly approved this activation step, the exact reviewed account-eligibility guard was applied once through the connected migration tool. Hosted history recorded **20260909124122**, name `require_eligible_staff_auth_account`. The statement SHA-256 is `7530eb7cd955ec1522943a179aebc03088a3ebc8126a4f4300e08eb5695bdc7b`.

The source now includes the byte-identical eighth migration at `supabase/migrations/20260909124122_require_eligible_staff_auth_account.sql`. Its old review-only comments remain unchanged to preserve the approved SQL hash; this dated record and the active manifest describe its current status. The prepared `20260909024020` copy and its manifest remain historical evidence. They are not another pending migration. The [guard history map](../tools/office-preflight/account-guard-hosted-history-2026-09-09.json) links the two names to the observed hosted version.

## What was verified

The recorded pre/post checks each passed 14 checks. The comparison preserved 11 catalog fingerprints, all seven original statement hashes and all aggregate counts. There were eight migration entries afterward, no Auth users, staff roles, stored objects or office records, and no security-advisor findings. Only `private.current_staff_role()` changed; its owner and privileges were retained. The source-alignment work performed no hosted operation.

The helper now requires a current, confirmed, nonanonymous Auth account with a nonblank email, no deletion mark and no active ban before returning a staff role. The guard affects subsequent database statements observing that state. It does not revoke an already issued signed URL, guarantee immediate interruption of an in-flight operation, or check Auth sessions on every statement. Limited own-role and own-profile permissions remain separate. Ordinary logout/token expiry, staff sign-in, reset/invitation delivery, actual hosted role/file behavior and recovery still require their own acceptance. Empty-catalog checks are not signed-in staff HTTP proof.

## How to use the aligned source

For a **fresh authorized environment**, use all eight migrations in the active manifest before granting staff access. For the **existing church project**, compare all eight recorded versions and hashes; do not replay the seven-file baseline, the prepared optional filename or the already applied eighth file. Unexpected drift requires investigation rather than migration-history repair or resetting data.

The readiness capability revision stays `20260907174301`; it does not itself prove that the guard is installed. Preflight format 3 requires the eighth file and pins its exact approved hash independently of the manifest digest. Both public-intake submission grants remain paused. No public configuration, client runtime, static packet, DNS, account or Auth setting is changed by source alignment.

The [September 8 map](../tools/office-preflight/hosted-history-map.json), earlier preparation map, original seven SQL files and historical optional manifests/results are retained. Before/after optional SQL tests use the exact frozen seven-file manifest. Fixed seven-version service/restore tools and the earlier optional eight-version local service tool deliberately refuse a changed active checkout; use their saved records for their historical scope, not as fresh-setup instructions. Their preserved projects, volumes and results were not touched. A new current-eight recovery claim requires a separately designed and executed rehearsal.

[Official migration tracking documentation](https://supabase.com/docs/guides/deployment/database-migrations) describes comparing tracked files with recorded history. Here the filename follows the actual recorded version; no guessed timestamp or remote history repair was used.

## Local alignment verification

Preflight passes 23 tests and 45 file checks. Wiring passes 14 tests. The active eight-migration paused-intake suite passes six results and the administrator setup suite passes 23. Historical frozen-seven guard/reopening suites retain nine/eight results. These 83 focused results use local files and fictional PostgreSQL fixtures; the full staff/browser suites and historical real-service/restore rehearsals were not rerun. No static release file or application runtime changed.
