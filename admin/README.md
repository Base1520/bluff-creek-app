# Creek Office setup

Creek Office is the private staff side of Home @ the Creek. It provides staff sign-in, calendar management, a contact/member CRM, private document storage, and an activity log. The repository contains no member data, staff credentials, or secret keys.

## Backend setup

1. Create a church-owned Supabase project. Do not use a personal project.
2. Run `supabase/schema.sql` in the project's SQL editor.
3. In Supabase Auth, create the first staff user. Public sign-up is not exposed by Creek Office.
4. Copy that user's UUID and run the final commented `insert into public.staff_roles` statement as `admin`.
5. Copy `config.example.js` to `config.js`. Add the project URL and **publishable** key. Never put a secret or `service_role` key in this repository.
6. Add each approved staff Auth user to `public.staff_roles` as `admin`, `editor`, or `viewer`.

The `church-documents` bucket is private. Staff receive signed links that expire after 60 seconds. Database and storage permissions are enforced through RLS; hiding buttons in the interface is only a usability feature.

## Roles

- `admin`: full current workspace access; intended for the pastor and designated church administrator.
- `editor`: can manage events, people, and documents.
- `viewer`: read-only access.

## Current scope

- Calendar CRUD with weekly/monthly/special labels.
- People records with household, status, contact fields, and notes.
- Private uploads categorized as policies, spreadsheets, forms, minutes, ministry, or other.
- Audit entries for database changes.

Before production use, connect the backend, run Supabase database tests/advisors, verify an `anon` request is denied, verify each staff role, and establish a written access-removal process for departing staff.
