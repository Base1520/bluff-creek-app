# Creek Office: first hosted activation

Prepared September 8, 2026, after Cole reported the Allen demonstration went well. The next increment is a small, private staff pilot. The historical archive can follow in reviewed batches.

## Ready for the next decision

Apply the **seven migrations in the committed preflight manifest**, in order, to the existing **Bluff Creek Church Office** project (`xzfeumdonxeodqhfirjr`). The first six hashes are unchanged; the seventh pauses public profile creation/updates by revoking both submission-function grants. Preserve the tracked migration history. Recheck the empty target immediately before starting and stop if it no longer matches.

This proposed schema-only step creates the office structure, private document bucket, permissions and recovery controls. It does not create or invite staff, import church records, send messages, change Auth settings, change DNS/hosting or publish the site/app. Those actions remain separate. Cole's earlier no-deploy/account/PII instruction is why this concrete activation step needs his approval.

September 8 read-only target evidence: healthy; 0 public tables, 0 Auth users, 0 buckets; no migration-history table or office-readiness function. A fresh public Auth settings GET returned 200, `disable_signup=false`, `mailer_autoconfirm=false`. The database pause is **prepared code**, not yet an applied hosted setting. It does not disable Auth signup or email sending.

After schema application, verify all seven history entries, all office table RLS/grants, private bucket policy, readiness function, both denied submission grants, retained staff review access and hosted advisors. These catalog checks are followed by actual hosted role/file/recovery tests once pilot identities and email are authorized. Do not mistake successful SQL application for accepted daily use.

## Complete static package

Run the offline `tools/office-release/` builder with the private reviewed settings. Uploadable files belong only in its `site/` folder. The hash manifest, setup checklist, SQL, tests, private inputs and working notes stay outside the public root. The builder includes the public app, staff office, recovery and connection pages; generated public connection settings stay blank in the first packet. The original Homestead design and public service-worker cache remain unchanged.

The proposed HTTPS origin is the existing `https://app.bluffcreekbaptistchurch.org`; staff sign-in is `/admin/` and recovery is `/admin/recovery.html`. Domain/hosting configuration and actual publishing need a separately reviewed release instruction. A localhost check is not hosted sign-in or a phone installation test.

## What follows, in order

1. **Staff ownership:** privately identify the first administrator and backup; agree who receives admin/editor/viewer. Editors currently have broad care/prayer/committee access. A deacon or teacher assignment is not an access restriction.
2. **Email:** configure an approved custom SMTP provider and exact callback. Test invitation, reset, expired links and access removal with specifically authorized recipients. Keep public signup disabled in Auth for the staff-only pilot when that setting change is approved; the SQL pause separately blocks profile writes.
3. **Recovery:** choose a church-controlled off-device location, retention and two operators. Prove both database and original uploaded files restore before real records. The earlier successful local six-migration restore is historical evidence, not a seven-migration hosted restore.
4. **Private pilot:** primary and backup each save/search a fictional person, review a source photo, record a contact, recover an interrupted edit and open the original file. Record actual results and resolve failures.
5. **Real work:** after pilot acceptance and private-data authorization, start a small approved batch of current office records. Keep the existing ledger available. Column 6, ledger scope/identity mapping and repeat-safe historical import remain undecided/unbuilt as recorded; do not infer Allen's answers.
6. **Public signup later:** review a tracked migration reopening intake, then test verified signup, own-profile updates, staff review and one welcome task before announcing it. A frontend checkbox/configuration cannot reopen the database.

## Email and backup budget to choose

The existing project was created on its approved $0 plan; there is no new charge or purchase in this preparation. For staff authentication, Resend's published Free allowance is 3,000 transactional emails/month with a 100/day cap; its Pro plan is $20/month for 50,000. This is a candidate for login/recovery email, not approval to create an account or change sending-domain DNS. The default Supabase mail service is limited to project-team recipients and is not intended for production. [Resend pricing](https://resend.com/pricing), [Supabase SMTP guidance](https://supabase.com/docs/guides/auth/auth-smtp).

Supabase publishes Pro from $25/month, including the first project; actual Base1520 organization/project billing must be quoted before any upgrade. Pro daily database backups retain seven days. Free projects need separately maintained exports. **Neither database backup includes original Storage file payloads**; those require a separate copy and restore process. The final off-device storage arrangement/cost is still undecided. [Supabase pricing](https://supabase.com/pricing), [backup scope](https://supabase.com/docs/guides/platform/backups).

The existing One Call service remains in use; replacement or outbound integration is deferred.
