# Local staff-workspace regression tests

Run from this directory with Node and npm (verified with Node 25.8.1):

```sh
npm ci --ignore-scripts
npm test
```

Exact development dependencies are pinned in `package.json` and `package-lock.json`. `node_modules` is ignored. These tools are not loaded by the public app or admin page.

`rls.test.mjs` starts in-memory PostgreSQL through PGlite with its `pgcrypto` extension and executes `supabase/schema.sql` unchanged. Minimal local `auth.users`, `auth.uid()` and Storage tables represent Supabase dependencies. SQL runs under real `anon` and `authenticated` roles using synthetic UUIDs. The matrix covers anonymous/nonstaff denial, viewer reads and write denial, editor/admin writes, bucket boundaries, upload ownership and size, audit restrictions, and immediate staff-role revocation.

`session.test.mjs` runs the actual browser script against a DOM and synthetic Supabase client. It covers auth callbacks outside the auth lock, account switching, late responses, clearing private DOM/dialogs, failed sign-out and late-token lockout, manual sign-in after lockout, owned storage cleanup, viewer controls, oversized uploads, interrupted upload metadata, document link expiry, secret-key rejection, and editor attribute escaping.

No real staff/member records, credentials or live project connection are used. These tests validate PostgreSQL policies and client behavior locally; they do not simulate the Supabase Auth server, signed-link enforcement or file upload transport. The church-owned project's settings, RLS advisors, role checks and Storage behavior still require an approved pre-production check after provisioning.

Primary references: [Supabase auth events](https://supabase.com/docs/reference/javascript/auth-onauthstatechange), [Supabase changelog](https://supabase.com/changelog), [PGlite extensions](https://pglite.dev/extensions/#pgcrypto).
