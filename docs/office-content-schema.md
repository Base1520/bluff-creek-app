# Private office content

`supabase/migrations/20260907231528_office_content.sql` adds announcements, committee contacts, Sunday slides, and staff prayer requests. Apply it once after `supabase/migrations/20260907231507_office_base.sql` and `supabase/migrations/20260907231527_membership_care.sql` through the reviewed database migration process. No hosted changes, accounts, personal records, or sample church content are included.

## Access and common fields

All four tables allow current **admins and editors** to select, insert, and update. Viewers, signed-in nonstaff, and anonymous visitors cannot read them. The migration explicitly revokes inherited/default privileges, grants only the required operations, enables RLS, and checks the current database `staff_roles` row. Client metadata cannot grant a role. An editor's downgrade or role removal takes effect on subsequent queries.

Every record has a generated UUID `id` and `created_at`, `created_by`, `updated_at`, and `updated_by`. The existing `private.stamp_membership_owned_record()` trigger sets actors from `auth.uid()` and timestamps from the database, preserves creation metadata on update, and rejects changes to an existing UUID. Clients should omit these fields when writing.

No client receives DELETE or TRUNCATE privileges. Set the record's status to `archived`, or `inactive` for committee contacts, to retain it without keeping it in the active workflow. These office drafts are editable records, not an append-only archive. Database owners and service credentials remain privileged; this is not tamper-proof retention or a backup system.

The existing audit trigger records the action, table, record ID, actor, and time. It does not copy titles, contact details, prayer text, or notes. A new restrictive read policy hides all four modules' audit entries from viewers and retains the previous care-history audit restrictions.

## Table contracts

| Table | Required content | Optional content | Status |
| --- | --- | --- | --- |
| `office_announcements` | `title` ≤160 characters; `body` ≤10,000 | `starts_on`, `ends_on` dates | `draft` (default), `ready`, `archived` |
| `committee_contacts` | `committee_name`, `contact_name`, each ≤160 characters | `role_label`, `email`, `phone`, `notes`; `term_start`, `term_end` dates | `active` (default), `inactive` |
| `sunday_slides` | `title` ≤160 characters; `service_date` date | `deck_url`, `document_id`, `notes` | `draft` (default), `ready`, `archived` |
| `office_prayer_requests` | `display_name` ≤160 characters; `request_text` ≤10,000 | `care_notes` | `active` (default), `answered`, `archived` |

Required text must contain a non-whitespace character. Optional notes/contact fields have no additional length restriction in this migration. Email and phone are stored as supplied text; no delivery or telephone service is configured. Date ranges can have unknown endpoints, but when both endpoints exist the end must be on or after the start. Same-day ranges are valid.

### Sunday slides

A slide record marked `ready` must have a `deck_url` or a valid `document_id`; both are allowed. The database rejects removing the only source while the record remains ready. The source can be replaced, or removed in the same update that returns the record to draft.

`deck_url` is nullable; send `null` for an empty form field. The pure `private.valid_office_deck_url(text)` helper accepts HTTPS domain links up to 4,096 characters, with an optional numeric port from 1–65,535. It rejects credentials in the authority, whitespace/control characters, backslashes, malformed authorities, and invalid hostname labels. It supports ordinary ASCII and punycode domain names; literal IPv6 hosts and raw internationalized hostnames are outside this deliberately limited input format. Path/query/fragment content is allowed, including encoded spaces and an `@` in the path. Validation makes no network request and does not prove that a destination exists, is safe, or grants access to the deck. The UI must still render a link safely.

`document_id` references the existing `documents` table with restrictive deletion. A referenced metadata row cannot be deleted until the slide reference is changed or removed. Slide references do **not** apply the membership archive's source locking or change existing document/Storage access: ordinary staff-readable documents remain staff-readable and their files remain subject to the existing update/delete rules. Marking a slide ready does not publish it or change an external provider's sharing permissions.

### Prayer sharing

Prayer records also have required `share_scope` (`staff_only`, `prayer_team`, or `church`; default `staff_only`) and `sharing_approved` (boolean; default false). Broader scopes require approval. Revoking approval while a broader scope remains set is rejected; return the scope to `staff_only` in the same update.

These fields record an internal staff decision. They do not create a prayer-team role, broaden database access, email anyone, or publish a prayer list. All request text and care notes remain accessible only to admins/editors, including requests marked `church` with approval. There is no public prayer intake endpoint or public read policy in this migration.

## Verification and limits

From `admin/tests`, run:

```sh
node --test office-content-rls.test.mjs
```

The synthetic PGlite suite executes the unchanged base schema, membership migration, and office-content migration under local PostgreSQL roles. Seven behavioral subtests pass (eight tests including the wrapper). Coverage includes simulated legacy broad grants, read/write/privacy boundaries, archival status updates, forged metadata, UUID preservation, metadata-only audit visibility, immediate role revocation, text/date constraints, URL rejection, slide-source requirements and document deletion restrictions, and prayer approval remaining private. A regression check confirms the new audit policy preserves existing membership-history privacy.

This validates local database behavior with minimal `auth`/`storage` fixtures. It does not validate hosted JWT issuance, Supabase Storage HTTP behavior, external deck access, browser rendering, or deployment settings. No tenant isolation, external publication, or automatic notification behavior is implied.

The access rules follow Supabase's [RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security) and [explicit API grant requirements](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically). Field relationships use PostgreSQL [CHECK and foreign-key constraints](https://www.postgresql.org/docs/current/ddl-constraints.html); the URL helper uses documented [regular-expression matching](https://www.postgresql.org/docs/current/functions-matching.html). Its immutable check depends only on its input, and its execution is revoked from public/anonymous roles. If its accepted syntax changes later, revalidate the dependent constraint against existing rows.
