# Weekly-email preferences — proposed package

This package adds explicit weekly-email preferences and an Office audience review. It does **not** send a newsletter, configure a provider, schedule mail, import subscribers or change anyone's preference for them. The active ten-migration manifest stays unchanged until a separately approved application and source alignment.

The official Supabase CLI generated `20260911023920_communication_preferences.sql` in a separate local scratch project. The UTC filename date is September 11; this package was prepared during the September 10 church work. The manifest pins the proposed SQL and the ten recorded baseline files. Existing guest registration, staff eligibility, roles, public intake, private Storage and email workers are preserved.

## API contract

- `get_app_communication_capabilities()` returns `{version:1,weekly_email:true}` to anon/authenticated callers. It is a constant-only public invoker function and grants no anonymous private-schema access.
- `get_my_communication_preferences()` returns only `{version,preference_version,weekly_email,email_matches,updated_at}` for the current eligible nonanonymous account. An absent preference is version 0, false, email_matches true and updated_at null. Email confirmation is not required for these public app accounts; their email remains self-reported.
- `set_my_communication_preferences(p_request_id,p_expected_version,p_weekly_email)` requires an explicit boolean and the current preference version. Each new successful request increments the preference version, even when the choice is unchanged. Staff have no RPC for changing somebody else's consent.
- `register_app_guest_with_preferences(p_request_id,p_profile,p_weekly_email,p_preference_version)` commits the existing guest registration and preference together. It returns the existing guest receipt plus `communication_preferences`. A preference conflict rolls back any new profile, task, welcome/notice job, receipt and optional deacon-rotation position. The original registration RPC still works without creating a weekly-email preference; omitted optional household fields retain their existing behavior.
- `get_office_communication_audience()` is admin/editor-only. It returns `{version:1,generated_at,total,rows}` with all current guest profiles, or fails with `COMMUNICATION_AUDIENCE_LIMIT_EXCEEDED` (`54000`) above 5,000. Each row contains only registration `id`, first/last name, preserved profile email, preference status/version and nullable preference timestamp. No Auth UUID, child details, address, prayer, contact notes or staff-review fields are projected.

Two private RLS tables hold current preferences and immutable receipt/history rows. PUBLIC, anon, authenticated and service_role have no direct privileges. Narrow identity-bearing public invoker RPCs call private definers with an empty search path. The current account's Auth row is locked before writes; no caller can supply a user identity or recipient email.

## Choice, replay and email changes

Every recorded choice is bound to the normalized Auth email at that commit. A changed email makes the old choice ineffective: the current getter returns weekly_email false and email_matches false until a new explicit choice. Case-only normalization does not count as a changed address. Updating a guest profile does not manufacture or transfer consent.

Receipts are keyed by current account, request UUID and operation mode. The immutable hash binds the requested boolean, expected preference version and, for combined registration, the existing canonical guest-payload hash. An exact replay returns its historical result even after a later opt-out or address change; it never rewrites current preferences. The client must refresh the getter before displaying current status. A reused request with different input returns `COMMUNICATION_REQUEST_CONFLICT` (`40001`); stale versions return `COMMUNICATION_VERSION_CONFLICT` (`40001`). Existing guest-payload conflicts may return `REQUEST_ID_CONFLICT` with the same SQLSTATE.

Twenty new opt-in requests per account per hour are allowed; further opt-ins fail with `COMMUNICATION_RATE_LIMIT` (`P0001`) without recording the request. Explicit opt-out remains available, and valid exact retries are checked before rate limits. Combined registration also retains the existing guest quota of ten requests per hour. No new email job is created by a preference-only change.

## Office audience meaning

The complete snapshot distinguishes `requested`, `not_requested`, `not_set`, `email_changed`, `account_unavailable` and `duplicate_email`. Requested requires an explicit current true preference, eligible Auth account, matching current Auth/profile/preference emails, a well-formed address and no duplicate ambiguity. Duplicate detection includes all profile emails and their current Auth emails, not just profiles that appear eligible. An unavailable account is labeled unavailable, while its duplicate can still cause another account to be held. Malformed current or profile addresses are held as unavailable; the original profile email remains visible for review. Display whitespace is trimmed without modifying stored records.

An audience export is a dated snapshot, not a mailing authorization that lasts indefinitely. A future sender must refresh consent and recipient status before sending, handle withdrawals and suppression, and record its own delivery outcomes. This package adds neither a bulk-mail sender nor email unsubscribe links and makes no claim that a self-reported mailbox belongs to the person submitting it.

## Verification

With the existing locked test dependencies available, run:

```sh
node --test tools/communication-preferences/communication-preferences.test.mjs
```

The focused PGlite suite passed **24/24** tests. It applies the exact frozen eight-file baseline plus the recorded direct-intake SQL; the extension-only tenth migration is hash-checked because PGlite does not load pg_cron/pg_net. Combined registration tests also apply the exact proposed deacon rotation to verify complete rollback and compatibility. Tests cover immutable replay after opt-out, changed-email binding, optimistic conflicts, quotas with withdrawal preserved, source/security preservation, duplicate/malformed audience holds, private projections and the 5,000/5,001 boundary.

The separate PostgreSQL 17.6 rehearsal passed **9/9 milestones**, including four observed waits on the actual Auth account row across independent sessions. It applied eight baseline migrations plus three application additions (recorded direct intake, proposed deacon rotation and proposed preferences) in one new fictional database. The pg_cron/pg_net extension-only migration was byte-verified and excluded from execution. Concurrent replay, withdrawal versus stale opt-in, email changes, atomic registration and complete rollback passed, along with audience holds and eight permission denials with a staff positive control. The created database was dropped; all four preexisting database entries and cluster role metadata were preserved. `test-report.json` retains the sanitized result and its evidence hash.

The active ten-migration manifest remains byte-identical. These checks used mocked Auth/Storage schemas and made no real Auth, PostgREST, Storage API, hosted, dispatcher or email-provider calls. They do not establish phone behavior, delivery, newsletter operation or hosted activation.

Relevant official references: [database function security](https://supabase.com/docs/guides/database/functions), [row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security), and [migration history](https://supabase.com/docs/guides/deployment/database-migrations).
