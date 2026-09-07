# Creek Office setup

Creek Office is the private staff side of Home @ the Creek. It provides staff sign-in, calendar management, a contact/member CRM, private document storage, and an activity log. The repository contains no member data, staff credentials, or secret keys.

## Backend setup

Before setup, run `node tools/office-preflight/cli.mjs` from the app repository root. See [the preflight guide](../tools/office-preflight/README.md). A passing local packet is not a configured or verified church backend.

1. Create a church-owned Supabase project. Do not use a personal project.
2. Run `supabase/schema.sql`, followed by `supabase/migrations/20260907_membership_care.sql`, `supabase/migrations/20260907_office_content.sql`, `supabase/migrations/20260907164733_app_connections_care_roles.sql`, `supabase/migrations/20260907171014_leader_followups.sql`, then `supabase/migrations/20260907174301_office_record_recovery.sql`, in that explicit order in the project's SQL editor. See [signup/care setup](../docs/signup-care-maintenance.md) for migration-order and activation details.
3. In Supabase Auth, create the first staff user. Public sign-up is not exposed by Creek Office.
4. Copy that user's UUID and run the final commented `insert into public.staff_roles` statement as `admin`.
5. Copy `config.example.js` to `config.js`. Add the project URL and **publishable** key. Never put a secret or `service_role` key in this repository.
6. Add each approved staff Auth user to `public.staff_roles` as `admin`, `editor`, or `viewer`.

The `church-documents` bucket is private and limits files to 50 MB. New uploads use the signed-in staff member's folder and uploader ID. Staff receive a clickable signed link that expires visibly after 60 seconds. Database and storage permissions are enforced through RLS; hiding buttons is only a usability feature.

Sessions use this tab's `sessionStorage` under `creek-office-auth`; refreshing the tab preserves sign-in without a durable localStorage session. Browser tab restoration may also restore sessionStorage, so use Sign out when leaving a shared device. Sign-out immediately clears private rows, filters, account labels, open dialogs and signed links. A failed server sign-out still clears only this workspace's owned storage keys and locks the UI against late auth callbacks until a successful manual sign-in. Other applications' browser storage is not cleared. Client setup rejects secret and `service_role` keys.

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
