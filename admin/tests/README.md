# Local staff-workspace regression tests

Run from this directory with Node and npm (latest complete run verified with Node 24.19.0; earlier runs used Node 25.8.1):

```sh
npm ci --ignore-scripts
npm test
```

Exact development dependencies are pinned in `package.json` and `package-lock.json`. `node_modules` is ignored. These tools are not loaded by the public app or admin page.

`rls.test.mjs` starts in-memory PostgreSQL through PGlite with its `pgcrypto` extension and executes `supabase/migrations/20260907231507_office_base.sql` unchanged. Minimal local `auth.users`, `auth.uid()` and Storage tables represent Supabase dependencies. SQL runs under real `anon` and `authenticated` roles using synthetic UUIDs. The matrix covers anonymous/nonstaff denial, viewer reads and write denial, editor/admin writes, bucket boundaries, upload ownership and size, audit restrictions, and immediate staff-role revocation.

`session.test.mjs` runs the actual browser script against a DOM and synthetic Supabase client. It covers auth callbacks outside the auth lock, account switching, late responses, clearing private DOM/dialogs, failed sign-out and late-token lockout, manual sign-in after lockout, owned storage cleanup, viewer controls, oversized uploads, interrupted upload metadata, document link expiry, secret-key rejection, and editor attribute escaping.

`membership-rls.test.mjs` applies the base schema and membership migration with legacy broad default grants, checking append-only records, correction identity, database-owned actors, role revocation, source-image privacy before and after linking, and preservation. `membership-ui.test.mjs` covers source review, uncertain dates, corrections, upload limits, pagination and session invalidation. `care.test.mjs` covers Central dates and daylight saving, attempted versus successful contacts, explicit next dates, pauses, guest/assignment updates, guidelines roles, pagination and stale sessions.

`office-content-rls.test.mjs` applies both migrations and verifies announcements, committee contacts, Sunday slides and prayer records: grants/RLS, role revocation, database-owned metadata, private audit, dates, deck links and sharing approval. `office-content-ui.test.mjs` covers editing and validation, literal text rendering, slide links and attachments, explicit approval after changing prayer scope, stale sessions and write results. The core session suite also checks that viewer navigation cannot open any of these private routes.

No real staff/member records, credentials or live project connection are used. These tests validate PostgreSQL policies and client behavior locally; they do not simulate the Supabase Auth server, signed-link enforcement or file upload transport. The church-owned project's settings, RLS advisors, role checks and Storage behavior still require an approved pre-production check after provisioning.

Primary references: [Supabase auth events](https://supabase.com/docs/reference/javascript/auth-onauthstatechange), [Supabase changelog](https://supabase.com/changelog), [PGlite extensions](https://pglite.dev/extensions/#pgcrypto).

`office-recovery-rls.test.mjs` applies the complete migration sequence and verifies immutable identities, server-owned versions, event archive/restore and delete denial, extended editor table versions, live-role/schema readiness and prerequisite failure. Updated UI suites exercise conflicting edits, committed-but-lost responses, stable retry identities, source upload recovery, pending field/close locks, same-user transient outages and forced private clearing. The reliability pass also verifies changed-draft discard confirmation; it does not promise browser-crash recovery.

September 7 verification: 183/183 staff tests pass. A macOS dataless dependency had blocked jsdom import; reinstalling the exact locked packages using the command above restored local files without changing package versions or lockfile hashes. The initial logout test now waits at most two seconds for its contact fixture to render; its immediate privacy-clearing assertions still run synchronously after Sign out. This local pass does not replace the hosted Auth/Storage and restore checks.
