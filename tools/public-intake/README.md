# Optional public app intake rollout

Prepared September 8, 2026. **Draft only; not applied or approved for hosted activation.**

`migrations/20260909010555_reopen_verified_public_app_intake.sql` is deliberately outside the active `supabase/migrations/` directory. The CLI-generated UTC filename was created with Supabase CLI 2.117.0 in an isolated scratch project and moved here without renaming. This directory is not discovered by the ordinary project migration workflow and is not part of either static release packet.

The current office baseline remains the same seven applied SQL files, ending in `20260908220718_pause_public_app_intake.sql`. Their original SHA-256 values, hosted-history mapping, active preflight manifest and capability revision are unchanged. This directory's separate `manifest.json` pins that baseline manifest and the optional SQL bytes; it does not claim an eighth hosted history entry.

## Exact database change

The transaction first hardens `private.verified_connection_email()`: each call must match the current Auth user, have a confirmed nonblank email, be nonanonymous, have no `deleted_at`, and have no ban still in effect. A ban that has expired is allowed. The helper keeps its existing `SECURITY DEFINER`, empty search path and restricted execution privileges. Because existing own-profile reads also use that helper, a deleted or currently banned account loses those reads as well.

It then grants `EXECUTE` to `authenticated` for exactly these two signatures and explicitly keeps `PUBLIC` and `anon` denied:

- `public.save_app_connection(text, text, text, text, boolean, text)`
- `private.save_app_connection(text, text, text, text, boolean, text)`

The public function remains an invoker wrapper. Its private implementation still checks the Auth identity and owns the profile by `auth.uid()`; callers cannot choose another account's ID or email. Both grants are necessary for that existing call chain. No table privilege, RLS policy, staff role, storage permission, schema revision, account, Auth setting or page configuration is changed. Staff review logic and its current-role check remain intact.

A submitted profile is pending staff review, not an approved membership record. Repeated submissions update the same profile and increment its version. An authorized admin/editor can review that version, link an existing person without overwriting membership history or create a new visitor, and create one welcome plan due two days after the original signup date. Retrying a completed review does not create another person, welcome plan or audit event. A later profile update returns to pending review and keeps its existing person link and welcome plan.

## Verification before considering activation

Run from the repository root with the installed locked test dependencies:

```sh
node --test tools/public-intake/reopen-rls.test.mjs
node tools/office-preflight/cli.mjs
```

The SQL tests use an isolated in-memory PGlite database and synthetic identities only. They apply the seven baseline files, prove intake is paused, then apply this draft there and exercise the resulting permissions. They compare function definitions, security/search paths and other privileges so an unrelated privilege change cannot pass as an intake reopening. This is SQL behavior verification, not hosted Auth, SMTP, PostgREST, service-advisor or phone acceptance. No hosted advisor is run as part of this offline packet.

## Activation sequence after separate approval

1. Finish and accept the real staff office and production Auth email delivery. Keep the working staff release and its `admin/config.js` unchanged during the public app rollout.
2. Review the optional SQL hash and the actual target project `xzfeumdonxeodqhfirjr`; reconcile its current seven-entry history with the pinned baseline. Verify the Auth columns used by the guard and the existing function/security/privilege inventory. Stop on drift. Ordinary SQL cannot establish that the operator selected the intended hosted project.
3. Prepare the public signup settings as a separate reviewed change. The browser flow in `js/connection.js` explicitly uses `https://app.bluffcreekbaptistchurch.org/connection.html`; that exact callback must be hosted and allowlisted. Preserve the staff recovery callback. Review default Site URL behavior for invitations and public email links instead of silently sending public links to the staff recovery page. Self-signup, email confirmation, production email templates and delivery must support the public flow; a staff invite/reset template must not be reused as public signup copy by accident.
4. Obtain explicit approval for the named migration and the separate Auth/configuration changes. Only then promote the reviewed SQL through the agreed tracked migration workflow. Preserve its reviewed bytes and record the actual hosted version and mapping before reconciling the active manifest and preflight tests/reporting. The eight-file rollout must be distinguished from the seven-file paused baseline; do not leave a preflight message claiming the final rollout migration pauses intake. Do not fabricate history, replay the seven applied migrations or run a history repair merely to match this draft's proposed timestamp.
5. Verify the hosted function grants and Auth-row checks, then activate the exact approved public connection configuration. The page alone cannot reopen the database; this SQL alone does not enable Auth signup or deliver email.
6. Rehearse a real authorized email-link journey: first signup, verified profile submission, pending staff queue, identity review, one person link and one welcome task, retry, profile update and repeat review. Verify ordinary callers cannot read other profiles or private notes, acquire staff roles or review themselves. Record delivery/receipt evidence without copying identities or profile data into Git or public screenshots.
7. Promote signup and distribute the phone QR only after the accepted public release and its actual phone checks. Existing Connect and Prayer email forms remain unsent mail drafts; they do not automatically become office intake when this migration is applied.

If intake must be paused later, use a separately reviewed tracked change revoking the same pair of submission grants. Preserve records and the strengthened identity helper; deleting data or undoing the seven-file baseline is not an intake rollback.

## Explicit limits

The new helper rejects deleted and currently banned Auth rows at database-call time. It does **not** check `auth.sessions`, invalidate access tokens, alter token lifetimes or guarantee immediate RPC rejection after ordinary sign-out/session revocation. Supabase access tokens can remain valid until expiry; adding stricter session checks would require a separately reviewed design and tests. Staff authorization remains based on the existing live `staff_roles` checks, not user-editable JWT metadata.

Real public intake creates personal records. This draft contains only synthetic test data and grants no permission to create real accounts, send email or import membership information. Owning the public welcome queue and accepting its contact workflow remain part of the office/public signup rehearsal, not a consequence of passing SQL tests.

Sources checked for this preparation: [Supabase function privileges and security](https://supabase.com/docs/guides/database/functions), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [sessions](https://supabase.com/docs/guides/auth/sessions), and the current Supabase changelog index. No relevant changelog entry changes this explicit function-grant approach.
