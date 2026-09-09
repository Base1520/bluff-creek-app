# Local staff-workspace regression tests

Run from this directory with Node and npm (latest complete run verified with Node 24.19.0; earlier runs used Node 25.8.1):

```sh
npm ci --ignore-scripts
npm test
```

Exact development dependencies are pinned in `package.json` and `package-lock.json`. `node_modules` is ignored. These tools are not loaded by the public app or admin page.

`rls.test.mjs` starts in-memory PostgreSQL through PGlite with its `pgcrypto` extension and executes `supabase/migrations/20260908220558_office_base.sql` unchanged. Minimal local `auth.users`, `auth.uid()` and Storage tables represent Supabase dependencies. SQL runs under real `anon` and `authenticated` roles using synthetic UUIDs. The matrix covers anonymous/nonstaff denial, viewer reads and write denial, editor/admin writes, bucket boundaries, upload ownership and size, audit restrictions, and immediate staff-role revocation.

`session.test.mjs` runs the actual browser script against a DOM and synthetic Supabase client. It covers auth callbacks outside the auth lock, account switching, late responses, clearing private DOM/dialogs, failed sign-out and late-token lockout, manual sign-in after lockout, owned storage cleanup, viewer controls, oversized uploads, interrupted upload metadata, document link expiry, secret-key rejection, and editor attribute escaping.

`membership-rls.test.mjs` applies the base schema and membership migration with legacy broad default grants, checking append-only records, correction identity, database-owned actors, role revocation, source-image privacy before and after linking, and preservation. `membership-ui.test.mjs` covers source review, uncertain dates, corrections, upload limits, pagination and session invalidation. `care.test.mjs` covers Central dates and daylight saving, attempted versus successful contacts, explicit next dates, pauses, guest/assignment updates, guidelines roles, pagination and stale sessions.

`office-content-rls.test.mjs` applies both migrations and verifies announcements, committee contacts, Sunday slides and prayer records: grants/RLS, role revocation, database-owned metadata, private audit, dates, deck links and sharing approval. `office-content-ui.test.mjs` covers editing and validation, literal text rendering, slide links and attachments, explicit approval after changing prayer scope, stale sessions and write results. The core session suite also checks that viewer navigation cannot open any of these private routes.

No real staff/member records, credentials or live project connection are used. These tests validate PostgreSQL policies and client behavior locally; they do not simulate the Supabase Auth server, signed-link enforcement or file upload transport. The church-owned project's settings, RLS advisors, role checks and Storage behavior still require an approved pre-production check after provisioning.

Primary references: [Supabase auth events](https://supabase.com/docs/reference/javascript/auth-onauthstatechange), [Supabase changelog](https://supabase.com/changelog), [PGlite extensions](https://pglite.dev/extensions/#pgcrypto).

`office-recovery-rls.test.mjs` applies the complete migration sequence and verifies immutable identities, server-owned versions, event archive/restore and delete denial, extended editor table versions, live-role/schema readiness and prerequisite failure. Updated UI suites exercise conflicting edits, committed-but-lost responses, stable retry identities, source upload recovery, pending field/close locks, same-user transient outages and forced private clearing. The reliability pass also verifies changed-draft discard confirmation; it does not promise browser-crash recovery.

September 7 verification: 183/183 staff tests pass. A macOS dataless dependency had blocked jsdom import; reinstalling the exact locked packages using the command above restored local files without changing package versions or lockfile hashes. The initial logout test now waits at most two seconds for its contact fixture to render; its immediate privacy-clearing assertions still run synchronously after Sign out. This local pass does not replace the hosted Auth/Storage and restore checks.

Later September 7 local-development update: **185/185 staff tests pass**, including 30 session tests. Explicit local HTTP configuration requires both the browser page and backend to use loopback addresses with explicit ports. The local document handoff also rejects HTTP links outside that exact backend origin. Public connection config has equivalent opt-in guards in the public suite (57/57). Production configuration is unchanged. See the separate [actual-service rehearsal](../../tools/office-rehearsal/README.md) for the Auth/Storage checks that these DOM/PGlite tests do not cover.

Staff recovery verification: **196/196 staff tests pass**, including 11 reset/invitation tests. The local service rehearsal additionally passed 38 HTTP checks, eight browser password-reset checks and seven browser invitation/first-password checks. These actual local Auth/Mailpit/Storage results remain separate from hosted delivery and backup/restore acceptance. The setup preflight now requires the two recovery files and passes 41 checks with 16 tests.

Public signup browser verification: **7/7 checks passed** through the actual local Auth email link, with one synthetic pending profile, no staff role, scrubbed callback and private state cleared on reload. Separate browser cleanup confirmed no staff role and an Auth ban for all three distinct registered browser identities; their isolated sessions were closed. Protected fictional history remains in the disposable stack.

## Staff-first intake pause

`public-intake-paused-rls.test.mjs` applies all seven manifest migrations with synthetic PostgreSQL records. It verifies revoked submission access at both function boundaries, unchanged rows/capability revision, retained own-profile privacy and admin/editor review. The earlier recovery and signup SQL tests target the first six migrations; their results are baseline behavior, not evidence that public intake stays open after the seventh step.

## September 9 late-response regressions

The core editor and membership-history suites now hold actual fixture promises across their UI deadline, perform an early absence check and settle the old request afterward. They verify unresolved upload/metadata/history protection, stable-ID retries, fresh reconciliation after settlement, and immediate clearing without late effects on replacement drafts. These are synthetic client-transport sequences, not proof of server cancellation or durable draft recovery.

Office-content cases reproduce access changes and replacement drafts during discard confirmation. The accepted decision must still refer to the original dialog, user and current record. Public `tests/connection.test.cjs` separately covers retry/read versus save ordering, a bounded read timeout and old-account cleanup isolation.
