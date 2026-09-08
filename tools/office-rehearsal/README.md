# Local office HTTP rehearsal

This dependency-free Node 24+ harness exercises the actual local Auth, PostgREST and Storage HTTP services after the six existing office migrations are applied to the disposable task stack. It does not start or configure a stack, apply migrations, alter schema/privileges, change migration history, or test the hosted church project. A narrowly restricted local SQL helper sets up and removes only registered synthetic fixtures; all application permission assertions still use the real user HTTP paths.

**Only `http://127.0.0.1:55321` is accepted.** The port belongs to the task's `bcbc-office-rehearsal` stack. Both the input validator and transport pin this exact origin. The built-in Node HTTP transport has no DNS lookup, inherited proxy, redirect following, or caller-supplied agent/host. This intentionally avoids an SDK download or added dependencies.

Node HTTP diagnostic modes (`NODE_DEBUG`, `NODE_DEBUG_NATIVE`) are refused because they can print authorization headers outside the harness logger. Explicit Node environment-proxy activation is also refused. Run from the ordinary non-debug local Node process described below.

**Latest verified result:** September 7, 2026, 8:11 p.m. America/Chicago — **38/38 local integration checks passed**, with zero failed/blocked checks and zero unconfirmed cleanup actions. The separate harness safety suite passed **18/18** under Node **24.19.0**. See [the dated result and limits](results-2026-09-07.md). These local results do not activate or accept the hosted office.

## Run the guard checks first

```sh
node --test tools/office-rehearsal/safety.test.mjs tools/office-rehearsal/fixture-sql.test.mjs
node tools/office-rehearsal/run.mjs --help
```

These 18 tests use synthetic values and mocked transport. They establish harness guards; the separately executed 38-check service rehearsal is recorded above. Preparing or regenerating these files alone does not establish another service pass.

## Provide credentials only in memory

The stack operator supplies local keys through inherited environment variables or a trusted process's stdin pipe. Do not put keys in command arguments, shell history, output logs, credential files, this README, fixtures, screenshots or Git. Do not paste an Auth response into the handoff.

Environment names:

- `BCBC_REHEARSAL_URL`: exact local origin above.
- `BCBC_REHEARSAL_ANON_KEY`: local public/anon key. A service-role JWT or `sb_secret_` value is refused here.
- `BCBC_REHEARSAL_SERVICE_KEY`: local service key, used only by the Node process for synthetic Auth setup/access cleanup and disposable Storage cleanup. Office table grants are not assumed.
- `BCBC_REHEARSAL_ALLOW_SYNTHETIC_WRITES`: exact value `local-fixtures-only`.

With these variables already injected by the stack operator:

```sh
node tools/office-rehearsal/run.mjs --run
```

For an in-memory stdin pipe, invoke `node tools/office-rehearsal/run.mjs --run --stdin`. Its JSON object contains exactly `url`, `anonKey`, `serviceKey`, and `allowSyntheticWrites: true`. There is no `--url`, key, SQL, reset, hosted, force or broad-cleanup flag. The program refuses missing/unknown options and sanitizes failures instead of dumping the input or server response.

The operator may retain the resulting **sanitized JSON report** as dated evidence. It contains check names/results, HTTP status and safe API codes, generated fixture IDs, and cleanup disposition. It excludes keys, passwords, sessions, signed URLs, profile responses and file contents. The harness writes no files itself.

## Restricted fixture bootstrap

The first actual HTTP attempt established that local Auth creation/password sign-in worked but `service_role` had no office table grants when `api.auto_expose_tables=false`. RLS bypass does not grant table privileges. This was a fixture-bootstrap assumption in the harness, not a product permission/schema bug. The harness does not add those grants or modify the product schema to accommodate its fixtures.

Instead, `fixture-sql.mjs` invokes only `/opt/homebrew/bin/docker` against the fixed Unix socket `unix:///private/tmp/bcbc-office-im-x20/colima/office/docker.sock`, running `psql` inside `supabase_db_bcbc-office-rehearsal`. It verifies that the socket belongs to the current user, resolves to this task's `work/office-runtime/colima/office/docker.sock`, and the running database container publishes only `127.0.0.1:55322`. It rechecks before each mutation. Host/context/TLS overrides are not inherited. SQL goes through stdin; no database credential or caller-provided command is accepted.

The helper allows exactly three operations: assign a registered synthetic Auth UUID one of `admin`/`editor`/`viewer`; revoke that exact synthetic user's staff role; remove an explicitly registered disposable row from `documents`, `office_announcements`, `office_prayer_requests` or `app_connections`. Every mutation checks the exact generated UUID and matching `.invalid` Auth email; row cleanup additionally checks the creator/owner. Preserved table/row deletion, arbitrary SQL, grants, role creation, migrations, history edits, triggers and reset operations are absent. The helper verifies the resulting role or absence before reporting success.

## Coverage

Five users are generated in memory with strong ephemeral passwords and addresses at `office-rehearsal.invalid`. The local Admin Auth API confirms their emails directly, followed by password sign-in. No signup-email, magic-link, recovery, invite, SMS, OAuth or mail endpoint is invoked. One nonstaff fixture carries forged user-editable admin metadata to verify that it does not confer authority.

Checks exercise:

- No-session and nonstaff denial; actual admin/editor/viewer readiness revision and module bounds.
- Viewer base-record reads, editor/admin writes, forbidden self-promotion, server-owned record identity/version and stale update rejection.
- Separate deacon/teacher care plans, protected history and attempts, viewer denial for sensitive care/content, and prayer sharing approval.
- Leadership owner isolation including administrator cross-owner denial, versioned journal RPC and absence from shared audit.
- Real Storage uploads, metadata and byte-for-byte downloads; private bucket/public-link denial; reserved membership-source restrictions before linkage; linked-source replacement/metadata protection.
- Authorized signed source URL minting, unauthenticated use of its short-lived bearer capability, and expiration. Signed URLs already issued are not claimed to expire immediately on role revocation.
- Verified profile submission through the actual RPC signatures; own-profile isolation; staff-only review; existing-person linkage without overwriting records; one welcome plan due two days after original submission; repeat-safe review and profile-update review; new visitor creation/retry.
- Current database role removal taking effect with the same still-unexpired editor token for reads, writes, readiness, leadership and new file access/signing. Other staff remain usable as a positive control.

Permission failures must accompany successful controls against the same fixture/service; an unavailable service is not counted as an RLS pass. A failed scenario leaves dependent work blocked while independent scenarios continue. Any failed/blocked check or uncertain cleanup yields a nonzero process exit and `failed_or_incomplete` status.

## Cleanup respects preservation rules

Each run uses fresh random UUIDs and registers its own attempted fixtures before requests. Cleanup never accepts external fixture IDs, deletes by name prefix, deletes a bucket, resets a database, disables a trigger, or changes history. Bounded local SQL removes only registered disposable metadata/content/intake rows; the Storage API removes ordinary test file paths. Source-image bytes and preserved contacts/events/history/care/leadership records remain as fictional evidence in the disposable stack.

For each exact generated Auth ID, cleanup verifies the matching synthetic email before changing access, removes that user's staff role, signs out its session and applies a long ban. Auth rows remain because preserved records/audit foreign keys may reference them. A role removal does not revoke already-issued access JWTs globally, so the report does not claim that; the actual office checks test database-backed role denial.

The report identifies attempted retained IDs rather than pretending every attempted insert exists. Uncertain cleanup is explicit. Keep any needed sanitized evidence before the stack owner separately disposes of this exact task stack. This harness never issues that destructive action.

## What this does not prove

No hosted activation/acceptance, real email delivery, phone/browser behavior, signed URL behavior through a production CDN, MFA/recovery, infrastructure backup/file restoration, or assigned-deacon-only visibility is established here. The current shared editor role remains broad; personal leadership notes have their own owner-only policy. The singleton `care_guidelines` document is not modified by this harness. Source-sensitive testing stays fictional.

## Source verification

The six SQL files in `supabase/migrations/` and current `admin/app.js`, `admin/membership.js`, `admin/signups.js`, `admin/followups.js` and `js/connection.js` define the actual policies/RPC signatures and expected capability revision `20260907174301`. No schema or client edit is part of this directory.

Official sources checked September 7, 2026:

- [Current changelog](https://supabase.com/changelog): reviewed relevant self-hosted gateway/Auth-prefix changes; the harness uses the standard `/auth/v1`, `/rest/v1`, `/storage/v1` routes on the CLI stack.
- [Auth createUser](https://supabase.com/docs/reference/javascript/auth-admin-createuser): local server-only user creation and direct email confirmation.
- [Official Auth admin implementation](https://github.com/supabase/auth-js/blob/master/src/GoTrueAdminApi.ts) and [password sign-in implementation](https://github.com/supabase/auth-js/blob/master/src/GoTrueClient.ts): HTTP routes and request shapes.
- [Private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals), [private downloads and signed URLs](https://supabase.com/docs/guides/storage/serving/downloads), and [official Storage implementation](https://github.com/supabase/storage-js/blob/master/src/packages/StorageFileApi.ts): authenticated download, upload, signing, removal and signed-capability limits.

Use the separate local stack tool's instructions to start services and provide credentials. Do not adapt this harness to a hosted origin.
