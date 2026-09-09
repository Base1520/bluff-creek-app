# Creek Office setup
For the post-demo hosted setup, use the [activation sequence](../docs/office-hosted-activation.md) and [offline wiring tool](../tools/office-wiring/README.md). The tool stages reviewed configuration separately; it never applies schema, invites staff or enables the hosted service.


Creek Office is the private staff side of Home @ the Creek. It provides staff sign-in, calendar management, a contact/member CRM, private document storage, and an activity log. The repository contains no member data, staff credentials, or secret keys.

## Backend setup

Before setup, run `node tools/office-preflight/cli.mjs` from the app repository root. See [the preflight guide](../tools/office-preflight/README.md). A passing local packet is not a configured or verified church backend.

1. Use the dedicated **Bluff Creek Church Office** project in Base1520 (`xzfeumdonxeodqhfirjr`). Its original seven migrations were applied September 8, and the explicitly approved account guard was applied September 9 as recorded version 20260909124122. Staff access, email and release acceptance remain separate. Do not create another project or use an unrelated database.
2. Compare the current eight-file manifest with hosted migration history before any further setup. All eight migrations are already applied to this project, with exact approved SQL hashes; verify them rather than rerunning them. The eighth guard is required before staff grants in a fresh environment; see the [guard application record](../docs/office-account-guard-hosted-2026-09-09.md). See the [migration history and activation guide](../docs/office-migrations.md) and [hosted verification](../docs/office-hosted-verification-2026-09-08.md). A new isolated rehearsal follows the manifest's explicit order; it does not change this hosted history.
3. After the specific account/invitation instruction, create or reconcile the approved primary and backup staff Auth accounts. Privately retain each exact email/UUID binding; do not recreate an account after an ambiguous response. Review the hosted recovery callback and approved SMTP route before any invitation. Public sign-up is not the staff-provisioning route.
4. Use the [private administrator setup tool](../tools/office-access/README.md) to prepare the reviewed primary and backup admin bindings. It verifies each intended email/UUID pair inside one guarded transaction, refuses conflicting roles and accepts existing admin grants without rewriting them. Review the actual project connection and obtain the explicit instruction before executing; the tool itself is offline. The historical bare-UUID SQL comment is not the operational setup procedure. Never commit the private input, generated SQL or real account identifiers.
5. Use the [offline wiring tool](../tools/office-wiring/README.md) to stage the reviewed project URL and modern **publishable** key in a separate directory. Review the generated files before placing them into an authorized release. `config.example.js` documents the format. Never put a secret or `service_role` key in browser configuration. Hosted login and recovery require a root HTTPS Supabase URL; legacy anon tokens are only supported by the explicit local rehearsal.
6. Confirm both administrator grants and independently rehearse their sign-in and recovery. Additional staff roles or changes to an existing role require a separate reviewed identity-bound access change; this two-admin tool does not assign editors/viewers or promote conflicting roles.

The `church-documents` bucket is private and limits files to 50 MB. New uploads use the signed-in staff member's folder and uploader ID. Staff receive a clickable signed link that expires visibly after 60 seconds. Database and storage permissions are enforced through RLS; hiding buttons is only a usability feature.

Sessions use this tab's `sessionStorage` under `creek-office-auth`; refreshing the tab preserves sign-in without a durable localStorage session. Browser tab restoration may also restore sessionStorage, so use Sign out when leaving a shared device. Sign-out immediately clears private rows, filters, account labels, open dialogs and signed links. A failed server sign-out still clears only this workspace's owned storage keys and locks the UI against late auth callbacks until a successful manual sign-in. Other applications' browser storage is not cleared. Client setup rejects secret and `service_role` keys.

## Staff password reset and first-password setup

The login page links to `admin/recovery.html`. It requests reset mail with an account-neutral response; that response does not confirm account existence or delivery. Reset and invitation emails must redirect to the exact approved origin's `/admin/recovery.html`, not the ordinary office page. Add that exact URL to Supabase Auth's redirect allowlist before using this flow. The local rehearsal configuration includes this callback; verify the actual production settings separately before using it.

The separate recovery page removes callback tokens from the URL before loading the SDK, accepts only recovery/invite implicit callbacks, and uses a memory-only Auth client. It verifies the email identity and reads the current user's `staff_roles` row before showing a password form and again before updating the password. An authorized administrator must assign the approved staff role before an invited person completes first-password setup. This browser page never creates accounts, sends invitations, writes roles or grants office access. A reset link cannot recover access to a lost email inbox; that still requires the designated account administrator's identity/recovery procedure.

If a verified, confirmed invitation arrives before its staff grant, the page offers **Check staff access**. Each deliberate check re-verifies the same account and current role; it does not poll or provision access. Only a successful query reporting no role permits this waiting state. Query errors, a different identity, invalid roles and ordinary recovery without staff access remain closed. Keep this tab open while the administrator finishes the grant: reloading ends its temporary session. Password entry stays hidden until a current authorized role is verified, and that role is checked again on save.

After a confirmed password update, the page clears its fields, discards its temporary client/subscription, attempts local sign-out, and sends the user back through the **Return to staff sign in** link for manual login. That link clears only this tab's known office Auth storage keys, so a previously saved office account does not open automatically; unrelated storage stays intact. Invalid/reused/expired links offer a fresh request; uncertain updates tell the user to try the new password at sign-in before requesting another link. Reloading closes the memory-only recovery session. Existing sessions in other office tabs are not claimed to be revoked by this page, and a previously issued link remains a bearer credential until its Auth validity ends. Do not log callbacks, passwords or mail bodies.

Before staff activation, rehearse reset and initial-password setup through the local captured mailbox, then the authorized hosted email provider: verify the callback, old/new password behavior, reused/expired links, removed-role denial, and manual sign-in. Focused synthetic tests are in `tests/recovery.test.mjs`; they do not prove email delivery. Official API references: [password reset](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail), [password update](https://supabase.com/docs/reference/javascript/auth-updateuser), [staff invitation](https://supabase.com/docs/reference/javascript/auth-admin-inviteuserbyemail), and [Auth events](https://supabase.com/docs/reference/javascript/auth-onauthstatechange).

## Roles

- `admin`: full current workspace access; intended for the pastor and designated church administrator.
- `editor`: can manage events, people, documents, membership history, care records, announcements, committee contacts, Sunday slides and prayer requests; can read guidelines.
- `viewer`: read-only access to the existing calendar, People summaries and general documents. Detailed membership history, care records and historical source images are restricted to editors/admins.

## Current scope

- Private staff calendar creation/editing and recoverable archive/restore with weekly/monthly/special labels. Staff cannot permanently delete calendar events through the client. It does not publish events to the website or app. The workspace links to iCloud for the church calendar and explains separate Apple editor invitations. The request sheet is intake only; staff enter approved changes in iCloud. `is_public` is reserved metadata and defaults to false.
- People records with household, status, contact fields, membership identifiers, historical date text and review flags; separate preserved history and source-page review.
- Guest intake, assigned deacon, visit/contact logs, adjustable on-screen follow-up reminders and admin-maintained guidelines.
- Announcements, committee contacts, a Sunday slide-deck library and editable private prayer requests. See [office content maintenance](../docs/office-content-maintenance.md) for planning statuses, sharing permissions and current publication limits.
- Private uploads categorized as policies, spreadsheets, forms, minutes, ministry, or other.
- Audit entries for database changes.

Before production use, connect the backend, run Supabase database tests/advisors, verify an `anon` request is denied, verify each staff role, and establish a written access-removal process for departing staff.

The local regression suite in [`tests/README.md`](tests/README.md) executes the schema in real in-memory PostgreSQL and tests session races with synthetic data. It does not provision or validate a live Supabase project. If a staff member signs out while an upload is already in flight, the client stops the metadata write after that upload returns; a storage administrator may need to remove that unreferenced object before retrying.


## Membership archive and care extension

The September 7 extension adds expanded People fields, append-only member history with page-photo review, first-time guest tracking, deacon assignments, visit notes, an adjustable due-contact queue and admin-maintained guidelines. Apply the membership/care migration after the base schema before using those fields. See [maintenance and activation limits](../docs/membership-care-maintenance.md) and [schema details](../docs/membership-schema.md). The working Google Sheet remains separate until access and reconciliation are completed; `membershipSheetUrl` is a private edit link, not automatic synchronization. No OCR, external reminders, real member import or assigned-deacon-only role is active.

## Optional app signup and ongoing care

The public `connection.html` flow is separate from staff sign-in. It verifies email, accepts voluntary personal-contact details, and sends submissions/updates to App signups for admin/editor review. It does not grant staff access or church membership. Public configuration remains blank. Staff review can link an existing person or create a visitor and one-time welcome task. Deacon and Sunday school plans have separate quarterly/monthly deadlines. See [maintenance, access and activation details](../docs/signup-care-maintenance.md).

## My follow-ups

Each admin/editor has a personal leadership contact list, visible only to that owner through the staff API. Recurring dates, snooze/pause and contact history appear in My follow-ups and on Overview. A generic weekly calendar file can be prepared and imported by the owner; no calendar notification is activated automatically. See [leadership follow-up maintenance](../docs/leadership-followups.md).

## Safe saves and recovery

The final recovery migration is required: the office checks the live staff role and expected schema declaration before enabling edits, then rechecks role/readiness before writes. Failed core reads pause editing and clear stale lists while preserving same-session drafts. Individual module load failures also block that module’s saves. A missing readiness function is a setup failure, not an empty new office. This check is not a substitute for the hosted role/storage/backup rehearsal.

Events, People, document details, care plans/guest records/guidelines and office content use server-owned versions to reject stale edits. New drafts reuse stable IDs; source and document uploads preserve recovery state. An uncertain result requires checking saved progress before repeating the submission. No uncertain upload is automatically deleted. Staff events are archived and restored; prior history and visit entries remain append-only.

Use the in-app [office guide](help.html) for the operator workflow and [reliability and recovery](../docs/office-reliability.md) for acceptance checks, backup responsibilities and remaining activation gates. Drafts are memory-only; do not treat the open browser as a backup.

The staff-first baseline pauses public profile submissions at both function entry points. Staff can continue ordinary office work and review any existing submissions. Auth signup and email delivery are separate settings; the pause changes neither. The public connection UI must stay blank until an explicitly reviewed later migration reopens intake and hosted signup testing passes. Use the complete [release package builder](../tools/office-release/README.md) for uploadable static files, not a local demo snapshot.
