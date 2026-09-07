# App connections and ongoing care · September 7, 2026

The candidate now includes an optional public signup/profile page, a private office review queue, and independent deacon, Sunday school, welcome, pastoral and additional-care plans. No church backend, Auth email delivery, One Call integration or external notification channel has been activated. Public connection configuration is blank; the page honestly offers the existing email-draft connection form until activation.

## Signup and review

`connection.html` is linked from I'm New and More. Installing or opening the app does not identify someone. A person requests an email sign-in link, verifies their email, and submits their chosen name/contact details with explicit permission for personal follow-up. An email-link request alone does not create an office signup. Signup does not make someone a church member, grant staff access, or enroll them in mass messaging.

The optional fields are surname, phone when email is preferred, and Sunday school class. The form does not collect household histories, birth dates or prayer/care notes. Email ownership comes from verified Auth data; all other details are self-reported. The page loads only that user's own submitted profile through a restricted RPC. Personal contact permission is required on each submission; mass-message consent is a separate future workflow. Requests to stop personal follow-up currently need staff assistance; staff can pause the relevant care plans.

The browser holds this page's unfinished fields and dedicated Auth session in memory. It uses a separate Auth storage key from Creek Office. Reloading or returning later requires a new email link. URL credentials are removed before SDK loading, `getUser()` verifies the current account, and stale session responses cannot restore another account's details. Page exit/sign-out clears fields. The service worker's explicit public allowlist excludes the connection page, its scripts and private API responses; no offline personal profile is offered.

**App signups** appears in the office sidebar and as an Overview count. Admins/editors can search new submissions and profile updates, review the submitted details, find an existing person or explicitly create a visitor. Identity confirmation is required. Linking preserves existing People fields and membership status; staff can separately edit a People record after verifying a requested change. A new visitor starts `needs_review=true`.

A successful review atomically links/creates the person, records the reviewed version, and creates a one-time welcome plan if that person has none. Its initial due date is the original submission's Central-time calendar date plus two days, even if review happens late. An existing welcome plan is not reset or reassigned. Staff can adjust it in Guests & care. Empty assignment names remain visibly unassigned and confer no access. The queue refreshes every minute while an authorized workspace tab is visible and has a manual refresh button. This is an in-workspace update, not delivered email/text/push alerts.

Later profile submissions update one intake row per Auth user and reopen it for review. The previous person link and review metadata remain; it cannot be silently relinked during routine review. Submitted profile fields represent the latest version, not an append-only history of every profile value. Review uses the displayed version and a database row lock: stale reviews fail, and a repeated successful review returns the existing result without creating another person, welcome plan or audit event. An uncertain outcome remains an error in the UI until confirmed. A concurrent review that chose a different existing person fails; an already-reviewed response explicitly says that the current draft was not applied. Identity review is blocked if the People list failed to load. Network refresh failures retain unsaved review drafts while disabling saves; sign-out, missing access and confirmed permission errors clear them.

## Separate care responsibilities

| Responsibility | New-plan preset | Intended use |
| --- | --- | --- |
| Deacon | Every 3 calendar months | Personal contact with each assigned person |
| Sunday school teacher | Every calendar month | Class connection and encouragement |
| Welcome team | Once, initially within 2 days | First personal response to a signup |
| Additional care | Editable 14-day interval | Optional second check-in; select one-time when appropriate |
| Pastoral care | Editable interval | A follow-up suited to a person's current needs |

The deacon and Sunday school goals come from the user's instruction. The welcome and additional-care timings are suggested starting points, not recorded church policy. Staff should agree a preferred method and timing with the person and coordinate responsibilities. Existing day-based schedules keep their values until edited.

A person can have one plan per care role. Contacts are recorded against both person and role, so a teacher's contact does not reset a deacon's deadline. Successful contact restarts only that recurring role's interval; an attempt does not. A next date recorded on the latest relevant contact takes precedence. Future-dated contact entries do not prematurely count as completed contact. A one-time task completes after a successful contact on/after its start date. Paused and completed plans remain visible.

Month arithmetic clamps to the last valid day: January 31 plus one month becomes February 28 (or 29 in a leap year). Dates use America/Chicago. These are rolling monthly/three-month intervals, not fixed calendar-quarter quotas.

**Care coverage** shows active people lacking a deacon or Sunday school plan, an assigned person, an unpaused recurring plan, or an interval within the target. Plans over 3 months/90 days for deacons or 1 month/30 days for teachers are flagged for review. It excludes visitors and historical inactive people; visitors can receive welcome/additional plans explicitly. Coverage indicates planned responsibility, not proof that contacts happened. Due/overdue rows and recorded successful contacts show completion separately.

Contacts, care plans and logs are still managed by approved staff admins/editors. Names such as an assigned deacon or teacher do not create logins or restrict data to that person's assignments. Assigned-leader-only access requires a separate role/visibility implementation before giving every ministry leader access.

## Prepared database contract and activation

Apply in this explicit order after separate church-backend authorization:

1. `supabase/schema.sql`
2. `supabase/migrations/20260907_membership_care.sql`
3. `supabase/migrations/20260907_office_content.sql`
4. `supabase/migrations/20260907164733_app_connections_care_roles.sql`

The new filename was generated using the Supabase CLI. The two legacy migration filenames share an eight-digit prefix; do not use automatic CLI migration ordering until their versions and any existing migration history have been normalized. The local tests and manual setup instructions use the explicit sequence above.

The new migration changes care uniqueness to `(contact_id, care_role)` and adds `care_role` to preserved visits, defaulting historical entries to their original deacon role. Plan identities cannot be changed; create/edit the other role's separate plan. Nullable `cadence_months` overrides `cadence_days`; `first_due_on` and `one_time` support a welcome task.

`app_connections` has admin/editor-only direct SELECT, no client writes, RLS and private metadata-only audit. Public SQL wrappers run as invoker and delegate to narrowly scoped private helpers with empty search paths. Anonymous execution is revoked. `save_app_connection` and `get_my_app_connection` require a live verified, nonanonymous Auth user; identity and email are server-derived. `review_app_connection` checks the live staff role. A public signup cannot create a staff role or read contacts, other signups, care notes or the staff audit log. Auth metadata is never used for staff authorization.

After the schema and hosted access checks pass, configure only the approved church project's URL and browser-safe publishable key in `js/connection-config.js`, with exact `allowedOrigins`. Each origin's `/connection.html` must also be allowed in Supabase Auth redirect settings; the page is currently designed for a root-domain deployment. Configure and verify church-approved Auth email delivery, rate limits and abuse controls, recovery, retention and staff handling of requests to stop contact. Do not reuse an unrelated project or put service credentials in browser code. No account or DNS configuration was changed to prepare this feature.

Rehearse real verified-email signup, resubmission, a stale staff review, sign-out, revoked staff/user access and an actual private welcome assignment in the authorized hosted environment. Verify no profile/private API response enters offline caches. Run hosted database/security advisors and backup/restore checks. Those external checks have not been performed by the local tests.

## Local verification

Run `npm --prefix admin/tests test` for staff UI/session and PGlite database tests, and `node --test tests/*.test.cjs` for public features, connection state/validation and private-route service-worker exclusions. Test records and Auth/Storage fixtures are synthetic. PGlite executes the SQL policies/functions, but is not a hosted Auth, SMTP or network-concurrency test.

Browser review uses the disposable local sample office. Data stays in that page's memory and resets on reload. A sample signup review creates one fictional visitor/welcome plan, and separate role plans can be edited and completed. No real membership ledger data, staff message, email sign-in link or private source image was used.
