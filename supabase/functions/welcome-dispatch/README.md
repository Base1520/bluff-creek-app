# Direct intake delivery worker

Activated September 10, 2026 in the reviewed church project. The two migrations
are recorded under their actual hosted versions in the active migration manifest.
The named one-minute schedule is installed. Do not rerun activation or create a
second job. Real guest, prayer and inbox acceptance is a separate operator check.

The app submits to transactional database RPCs first. A valid receipt means the
record, follow-up task and email jobs are saved together. The browser then calls
this function with an empty JSON object. A one-minute scheduled retry drains jobs
even if the browser closes. No mail operation can roll back a submitted prayer or
guest registration.

The worker validates the real Auth user and scopes immediate work to that user's
submission jobs. A separate server-only scheduler secret permits bounded batches.
Recipients come only from database jobs. Guests cannot choose notification
recipients, payloads, template versions, job IDs or staff assignments. Public
accounts may have self-reported, unverified email; approved Office roles remain
separate. Prayer and guest details never appear in staff notification emails.

## Delivery semantics

- `sent` means Resend accepted the message, not confirmed inbox delivery.
- Stable job ID plus frozen template version forms the provider idempotency key.
  Retain existing version builders byte-for-byte when adding a new version.
- Database leases expire after 120 seconds; provider and database HTTP waits are
  bounded at eight seconds. Retry after uncertain responses uses the same payload.
- After 23 hours from the first attempt, uncertain delivery requires attention.
  Resend's deduplication window is 24 hours; never silently start a fresh job.
- A shared trial limit of 80 first message attempts per UTC day covers welcome
  and staff notices together. Retries retain their slot. Extra jobs stay queued;
  this is a message budget, not 80 guests. Two Office notices plus one welcome
  consume three slots. Review actual provider capacity before broad Sunday use.
- Queue status is visible in Office. The worker returns counts only and does not
  log names, email addresses, tokens, provider errors or prayer text.

## Reviewed activation procedure (completed)

1. Confirm the church project is `xzfeumdonxeodqhfirjr`, its historical eight
   migration hashes match, and the two approved administrators are preserved.
2. Apply the reviewed direct-intake migrations once. The active manifest now has
   ten hosted migrations; the frozen eight-file baseline remains for regression
   checks. Do not use the old `tools/public-intake` reopening package.
3. Create one dedicated Sending-only Resend key scoped to
   `auth.bluffcreekbaptistchurch.org`. Store it only as
   `CREEK_WELCOME_RESEND_KEY`. Do not read, reuse, replace or revoke either SMTP key.
4. Set server `CREEK_PUBLIC_KEY` to the church publishable key. Use the runtime's
   `SUPABASE_SECRET_KEYS` dictionary's valid `default` key, with a valid legacy
   `SUPABASE_SERVICE_ROLE_KEY` fallback. Modern keys go only in the RPC `apikey`
   header. Never put service credentials in browser files.
   Generate a dedicated random `CREEK_WELCOME_JOB_SECRET`, put the same value in
   Supabase Vault as `creek_welcome_job_secret`, and do not print it or commit it.
5. Deploy only this function with `verify_jwt=false` as shown in
   `config.example.toml`. Its handler performs its own user/scheduler authorization.
6. Install `pg_cron` and `pg_net` through a CLI-generated reviewed migration, then
   apply the reviewed `activation/schedule.sql`. It refuses an existing named job.
   Its PostgreSQL-compatible guard checks the secret length separately from its
   URL-safe characters (the original regex repetition bound of 256 was invalid).
7. Preserve the existing SMTP sender and Office invite template. Change the shared
   recovery subject to **Reset your Creek password** and body to the exact
   `activation/recovery-email.html`. Preserve Site URL and the existing exact
   `/admin/recovery.html` redirect; add the exact
   `https://app.bluffcreekbaptistchurch.org/connection.html` redirect, no wildcard.
8. Per Cole's explicit choice, turn email confirmation off for email/password
   app accounts. Keep anonymous signup off and preserve staff-role eligibility.
   Enable public email/password signup only with the reviewed frontend release.
9. Publish the separately reviewed static-only app/Office candidate with its
   enabled public configuration. The source clone is not a Pages publication tree.
10. Verify a real authorized registration and prayer through Office and provider
    acceptance after activation. Do not seed fictional people into production or
    claim synthetic tests prove real inbox delivery.

Pause procedure: disable public signup and revoke the new public intake entry
points if needed; pause this one scheduled job and worker delivery. Preserve
records, receipts, tasks, job IDs and templates for safe recovery. Keep Office
available for existing records. Never delete jobs or retry uncertain mail under
new IDs merely to clear an error.

## Local checks

`node --test supabase/functions/welcome-dispatch/handler.test.mjs`

`deno check --no-config supabase/functions/welcome-dispatch/index.ts`

The tests inject synthetic Auth/database/provider responses and make no network
requests, create no accounts and send no messages.

Sources: [Supabase scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions),
[Supabase function authentication](https://supabase.com/docs/guides/functions/auth-headers),
[Supabase server key migration](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys),
[Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).
