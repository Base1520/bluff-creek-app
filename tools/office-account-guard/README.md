# Staff account eligibility guard — hosted application pending

**Current status, September 9:** this guard was explicitly approved and applied at recorded version `20260909124122`; its byte-identical active copy is now required as migration eight. See [hosted application and limits](../../docs/office-account-guard-hosted-2026-09-09.md). The prepared SQL and manifest here remain unchanged historical evidence, not another pending migration. The before/after tests below use the frozen seven-file manifest.

## Historical preparation and local verification

This optional migration closes a specific office access gap. The seven-file baseline looks up a staff role by user ID but does not check the current Auth account state. A valid existing token can therefore still exercise that staff role after an account is temporarily banned or marked deleted. The baseline also accepts staff accounts that become unconfirmed, anonymous, or lose their email. The browser alone is not an authorization boundary for direct API requests.

Local PostgreSQL reproduction demonstrated private contact reads, Storage row reads, the office readiness RPC and editor/admin event writes under those ineligible account states. A role deletion already stops protected office operations; the new guard preserves that behavior.

The migration replaces only `private.current_staff_role()`. It retains the existing enum return type, stable SQL behavior, security-definer owner, empty search path and execution ACL. An eligible staff role now also requires a matching current Auth account that is nonanonymous, has a confirmed nonblank email, is not marked deleted, and is not currently banned. An expired ban permits the existing role again. This matches the office's intended confirmed-email staff access; phone-only/unconfirmed accounts are not supported by this pilot.

No new role, function grant, table, policy, record or account is created. The current-user and role lookups use existing primary keys. Nothing changes the original seven migration files, their manifest, readiness revision, public intake pause, browser code or either static release packet. `manifest.json` identifies the optional file and its exact SHA-256. The CLI generated its filename in an isolated scratch directory; it is deliberately outside `supabase/migrations`.

## Limits

The guard applies to office policies and RPCs that use `private.current_staff_role()`. It does not globally revoke a JWT, change Auth settings, or revoke an already issued signed file URL. Previously downloaded files and already rendered records cannot be recalled. Reads already in flight use PostgreSQL's transaction snapshot; the new account state is enforced by subsequent database statements observing that state.

The narrow existing permission to read one's own staff-role row remains unchanged. Own-profile APIs also retain their separate identity checks; they are not staff access. Public submission remains paused, and the separate `tools/public-intake` migration is neither applied nor incorporated here.

Ordinary sign-out still follows Supabase's access-token lifetime behavior. This change does not query `auth.sessions`, change token expiry, or add session policies. Immediate global sign-out enforcement would be a distinct reviewed design. For immediate **office staff-role removal**, use the authorized role-revocation process and verify denial; do not treat a pending UI sign-out as a completed access-removal operation.

## Verification and activation

Run the focused local PostgreSQL tests and unchanged active source preflight:

```sh
node --test tools/office-account-guard/guard-rls.test.mjs
node tools/office-preflight/cli.mjs --json
```

Tests use fictional `.invalid` identities and a disposable in-memory PostgreSQL instance, with all seven original migrations verified and executed. They are not real HTTP/JWT-signature checks or hosted acceptance. No real records, keys or recipients are inputs.

September 8 verification passed all nine test results (one parent and eight subtests), covering 18 identity states. The suite reproduces the baseline gap, verifies protected contact/event/file operations, retains the limited own-role/profile exceptions, tests confirmation followed by role revocation, and proves the helper definition is the only catalog change. All 17 office tables plus Auth and Storage fixtures remain unchanged by guarded operations; the active source preflight still passes 43 checks. A second reviewer independently checked the SQL, manifest and these stated limits.

September 9 real-service acceptance also passed eight milestones in a new, unlinked local stack with this guard present from startup. Four fictional password sessions exercised active staff controls, same-token ban/unban and role removal, private original upload/read/signing, paused intake and exact fixture containment. An earlier signed URL remained usable after the ban, confirming the stated bearer-link limit. All 32 preparation/service-guard tests passed; the new stack finished stopped with its volumes retained and six predecessor projects unchanged. [The separate result](../office-account-guard-service/results.json) does not establish a real-service pre-guard reproduction, hosted activation or email/phone acceptance. The optional file remains outside the unchanged seven-file active manifest and unapplied to the hosted project.

Before any authorized application, independently review the exact optional file, confirm the intended church project and current migration history/helper definition/ACL, and reconcile unexpected drift. Do not replay the original seven migrations or replace this optional filename with a guessed timestamp. Hosted application is on hold with the other blocked activation actions; do not use this file as an alternate way to change a project setting or permission without authorization.

After an explicitly approved application, verify the exact recorded statement hash, unchanged helper ACL/security attributes and protected operation matrix using authorized synthetic identities. Verify an active confirmed staff login and invitation/recovery flow, then prove that role removal and current account ineligibility close protected office reads/writes. Run advisors and retain the distinct real-service result. A local pass does not remove the release, email, backup/restore or operator acceptance gates.

## Primary sources checked September 8, 2026

- [Supabase user management](https://supabase.com/docs/guides/auth/managing-user-data): bans do not revoke existing sessions; deletion alone does not retroactively invalidate every outstanding access token.
- [Supabase sessions](https://supabase.com/docs/guides/auth/sessions): JWT lifetime and the separate `auth.sessions` check for stronger logout enforcement; timeout cleanup is not immediate.
- [PostgreSQL CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html): replacing a function preserves its ownership and permissions, while security-definer/search-path behavior requires explicit care.

The current Supabase changelog was checked. No hosted account, configuration, schema or data was changed during preparation.
