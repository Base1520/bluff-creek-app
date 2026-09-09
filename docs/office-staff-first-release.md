# Creek Office: first hosted activation

Prepared September 8, 2026, after Cole reported the Allen demonstration went well. The next increment is a small, private staff pilot. The historical archive can follow in reviewed batches.

## Hosted schema applied September 8

After Cole's explicit schema-only approval, all **seven reviewed migrations** were applied in order to **Bluff Creek Church Office** (`xzfeumdonxeodqhfirjr`). Hosted history contains seven entries, each with one statement whose SHA-256 exactly matches the approved SQL. The connected migration tool recorded new timestamp versions; the current filenames and manifest now match those versions. The original-to-recorded mapping is preserved in `tools/office-preflight/hosted-history-map.json`. Do not reapply the original versions or repair history blindly.

The office structure, private document bucket, permissions and recovery controls now exist in the hosted project. Catalog verification confirmed all 17 office tables have RLS, anonymous table grants are absent, the private bucket has all eight intended Storage policies, and both public/private profile-write functions deny browser execution. All 27 application functions match their intended security mode, empty search path and public/anonymous privilege boundaries. The hosted security advisor returned no findings. Auth, office and storage record counts remain zero.

Before application the target was rechecked as healthy and empty. The last Auth settings GET returned 200, `disable_signup=false`, `mailer_autoconfirm=false`. No Auth setting changed. The database profile-write pause is now applied; Auth signup and email configuration remain separate. Two intended administrators were supplied privately after schema approval; no Auth users, staff roles or invitations have been created.

Hosted catalog checks are complete. Actual signed-in role/file/recovery tests follow staff and email setup. The performance advisor reported informational missing-FK-index and unused-index notices on the empty database; review actual workload before changing indexes. See [the dated hosted verification](office-hosted-verification-2026-09-08.md) for evidence and limits. Daily office use and public release are not yet accepted.

## Complete static package

Run the offline `tools/office-release/` builder with the private reviewed settings. Uploadable files belong only in its `site/` folder. The hash manifest, setup checklist, SQL, tests, private inputs and working notes stay outside the public root. The builder includes the public app, staff office, recovery and connection pages; generated public connection settings stay blank in the first packet. The original Homestead design and public service-worker cache remain unchanged.

The proposed HTTPS origin is the existing `https://app.bluffcreekbaptistchurch.org`; staff sign-in is `/admin/` and recovery is `/admin/recovery.html`. Domain/hosting configuration and actual publishing need a separately reviewed release instruction. A localhost check is not hosted sign-in or a phone installation test.

## What follows, in order

1. **Staff ownership:** the first two intended administrators are identified privately. Use the reviewed [staff access preparation](../tools/office-access/README.md) to match approved emails to actual Auth user IDs before granting either role. Agree the wider admin/editor/viewer access boundary. Editors currently have broad care/prayer/committee access. A deacon or teacher assignment is not an access restriction.
2. **Email:** configure an approved custom SMTP provider and exact callback. Test invitation, reset, expired links and access removal with specifically authorized recipients. Keep public signup disabled in Auth for the staff-only pilot when that setting change is approved; the SQL pause separately blocks profile writes.
3. **Recovery:** choose a church-controlled off-device location, retention and two operators. Prove both database and original uploaded files restore before real records. The earlier successful local six-migration restore is historical evidence, not a seven-migration hosted restore.
4. **Private pilot:** primary and backup each save/search a fictional person, review a source photo, record a contact, recover an interrupted edit and open the original file. Record actual results and resolve failures.
5. **Real work:** after pilot acceptance and private-data authorization, start a small approved batch of current office records. Keep the existing ledger available. Column 6, ledger scope/identity mapping and repeat-safe historical import remain undecided/unbuilt as recorded; do not infer Allen's answers.
6. **Public signup later:** review a tracked migration reopening intake, then test verified signup, own-profile updates, staff review and one welcome task before announcing it. A frontend checkbox/configuration cannot reopen the database.

## Email and backup budget to choose

The existing project was created on its approved $0 plan; there is no new charge or purchase in this preparation. For staff authentication, Resend's published Free allowance is 3,000 transactional emails/month with a 100/day cap; its Pro plan is $20/month for 50,000. This is a candidate for login/recovery email, not approval to create an account or change sending-domain DNS. The default Supabase mail service is limited to project-team recipients and is not intended for production. [Resend pricing](https://resend.com/pricing), [Supabase SMTP guidance](https://supabase.com/docs/guides/auth/auth-smtp).

Supabase publishes Pro from $25/month, including the first project; actual Base1520 organization/project billing must be quoted before any upgrade. Pro daily database backups retain seven days. Free projects need separately maintained exports. **Neither database backup includes original Storage file payloads**; those require a separate copy and restore process. The final off-device storage arrangement/cost is still undecided. [Supabase pricing](https://supabase.com/pricing), [backup scope](https://supabase.com/docs/guides/platform/backups).

The existing One Call service remains in use; replacement or outbound integration is deferred.
