# Creek Office setup

Creek Office is the private staff side of Home @ the Creek. It provides staff sign-in, calendar management, a contact/member CRM, private document storage, and an activity log. The repository contains no member data, staff credentials, or secret keys.

## Backend setup

1. Create a church-owned Supabase project. Do not use a personal project.
2. Run `supabase/schema.sql` in the project's SQL editor.
3. In Supabase Auth, create the first staff user. Public sign-up is not exposed by Creek Office.
4. Copy that user's UUID and run the final commented `insert into public.staff_roles` statement as `admin`.
5. Copy `config.example.js` to `config.js`. Add the project URL and **publishable** key. Never put a secret or `service_role` key in this repository.
6. Add each approved staff Auth user to `public.staff_roles` as `admin`, `editor`, or `viewer`.

The `church-documents` bucket is private and limits files to 50 MB. New uploads use the signed-in staff member's folder and uploader ID. Staff receive a clickable signed link that expires visibly after 60 seconds. Database and storage permissions are enforced through RLS; hiding buttons is only a usability feature.

Sessions use this tab's `sessionStorage` under `creek-office-auth`; refreshing the tab preserves sign-in without a durable localStorage session. Browser tab restoration may also restore sessionStorage, so use Sign out when leaving a shared device. Sign-out immediately clears private rows, filters, account labels, open dialogs and signed links. A failed server sign-out still clears only this workspace's owned storage keys and locks the UI against late auth callbacks until a successful manual sign-in. Other applications' browser storage is not cleared. Client setup rejects secret and `service_role` keys.

## Roles

- `admin`: full current workspace access; intended for the pastor and designated church administrator.
- `editor`: can manage events, people, and documents.
- `viewer`: read-only access.

## Current scope

- Private staff calendar CRUD with weekly/monthly/special labels. It does not publish events to the website or app. The authenticated workspace links to the approved church calendar sheet for public events; `is_public` is reserved metadata and defaults to false.
- People records with household, status, contact fields, and notes.
- Private uploads categorized as policies, spreadsheets, forms, minutes, ministry, or other.
- Audit entries for database changes.

Before production use, connect the backend, run Supabase database tests/advisors, verify an `anon` request is denied, verify each staff role, and establish a written access-removal process for departing staff.

The local regression suite in [`tests/README.md`](tests/README.md) executes the schema in real in-memory PostgreSQL and tests session races with synthetic data. It does not provision or validate a live Supabase project. If a staff member signs out while an upload is already in flight, the client stops the metadata write after that upload returns; a storage administrator may need to remove that unreferenced object before retrying.
