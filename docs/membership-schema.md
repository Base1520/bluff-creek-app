# Private membership and care records

`supabase/migrations/20260907231527_membership_care.sql` extends the existing Creek Office schema. Apply it once, **after** `supabase/migrations/20260907231507_office_base.sql`, through the reviewed database migration process. This branch prepares the migration; it does not apply it to a hosted project, create staff accounts, or import membership data. The migration contains no people, contact details, or invented church policy.

The later [signup/care migration](signup-care-maintenance.md) extends this base contract to one plan per person and care role, calendar-month intervals, one-time welcome tasks and separate role histories. The `contact_id`-only uniqueness described below applies to the original migration before that extension.

## Access and preservation

| Records | Admin | Editor | Viewer / nonstaff / anonymous |
| --- | --- | --- | --- |
| Contacts, including the new summary fields | Read and update; no hard delete | Read and update; no hard delete | Viewer retains existing contact read access; others denied |
| Membership history | Read and append | Read and append | Denied |
| Care assignments and guest intake | Read, create, update | Read, create, update | Denied |
| Care visits | Read and append | Read and append | Denied |
| Care guidelines | Read, create, update | Read | Denied |
| History source documents and files | Read; preserve once linked | Read; preserve once linked | Denied |

There is no deacon account role or tenant model in this migration. `assigned_to` and `visitor_name` are descriptive text and never grant access. Authorization comes from the current database `staff_roles` row; removing or changing that row takes effect on subsequent queries. Arbitrary client claims or user metadata cannot assign a role. This is one church's staff application, not demonstrated isolation between multiple organizations.

Contacts remain viewer-readable, including names, existing notes, and the added membership summary fields. Detailed history, care notes, guidelines, and source images are separate and restricted to editors/admins. Do not put editor-only care notes into the viewer-readable contact notes field. No new table is a public website feed, despite residing in PostgreSQL's `public` schema.

Explicit grants and row-level security both enforce access. New tables receive no client delete or truncate grant. The migration also removes the base contact delete grant and policy. Contact delete/truncate and history/visit update/delete/truncate triggers reject ordinary SQL mutations even when a table owner bypasses RLS. Retire a contact with `status='inactive'`; append a history correction rather than changing the old entry.

## Data contract

All new record IDs are generated UUIDs except the guidelines singleton. New audit actor fields reference `auth.users`. Required foreign keys to contacts use restrictive deletion, with no cascading loss of history.

**Contacts:** optional `legacy_member_id` is unique and cannot be blank when present. `membership_number`, `middle_name`, `preferred_name`, `former_names`, `address`, `birth_date_text`, `received_date_text`, `baptism_date_text`, `dismissal_date_text`, `how_received`, and `reason_for_decrease` are nullable text. `needs_review` defaults to false. Preserve uncertain historical wording such as an approximate year in text; do not fabricate a complete date. Member numbers are not assumed unique.

**`membership_history`:** `contact_id`, nonblank `event_type`, optional exact `event_date`, `date_text`, `details`, `source_label`, `source_document_id`, and `corrects_id`, plus `created_at`/`created_by`. Event types are descriptive text to accommodate historical records. A correction must reference an already-existing entry belonging to the same contact. Self-reference and cross-contact correction are rejected. The old entry and its source remain intact; the UI can show the correction chain.

**`care_assignments`:** unique `contact_id`, nullable `assigned_to`, `cadence_days` from 1–365 (default 28), required `started_on` (default current Chicago date), `paused` (default false), and nullable `notes`. Upsert on `contact_id` is supported. An existing assignment cannot move to a different contact.

**`care_visits`:** `contact_id`, nonblank `visitor_name`, required `contacted_on`, `method` (`call`, `visit`, `text`, `email`, or `other`; default `visit`), `outcome` (`contacted` or `attempted`; default `contacted`), optional `notes` and `next_contact_on`, plus creation metadata. Visits are append-only; if a record needs clarification, add a new entry explaining it.

**`guest_intakes`:** unique `contact_id`, optional `first_visit_on`, `next_step`, `follow_up_on`, and `notes`; `status` is `new`, `contacted`, `connected`, or `closed` (default `new`). Upsert on `contact_id` is supported. An existing intake cannot move to a different contact.

**`care_guidelines`:** the only permitted `id` is `default`; `body` must be nonblank. Admins can upsert this singleton after the church approves its content. It starts empty.

Assignments, intakes, and guidelines include `created_at`/`created_by` and `updated_at`/`updated_by`. Triggers supply actors from `auth.uid()` and timestamps from the database. Clients should omit those fields. Updates preserve creation metadata and record identity; contacts gain the same preservation of creation metadata. Inserts/updates write only action, table, record ID, actor, and timestamp to the existing audit log. New care/history audit entries are hidden from viewers; note bodies are not copied into the audit log.

## Historical source images

Use the private `church-documents` bucket and this reserved path for a history upload:

`<authenticated-user-id>/membership-history/<generated-file-name>`

The reserved second path segment hides the upload from viewers immediately, before document metadata and the history entry exist. Insert the existing `documents` row with category `other`, then append history with its `source_document_id`. If a later step fails, the reserved upload remains private; linking the completed document can be retried. The three operations are not one transaction.

Once linked, the source document's entire metadata row is immutable. Restrictive Storage policies deny authenticated clients replacement uploads, updates/renames, and deletes at its referenced path. Previously uploaded files outside the reserved path also become viewer-hidden and locked when referenced by history. Other documents retain their existing staff access. A correction uses a new entry and, when needed, a new source document; it never replaces the original.

These are application/database safeguards, not immutable backup storage. Service credentials and database owners can bypass Storage RLS, and administrators can alter or disable database guards. The existing audit table is not a tamper-proof ledger for privileged database administrators. Keep service credentials out of the browser and use separately reviewed backup and retention procedures.

## Verification and deployment limits

Run `node --test membership-rls.test.mjs` from `admin/tests`. The synthetic PGlite suite executes the unchanged base schema followed by this migration, including simulated legacy broad default grants. It checks roles and immediate revocation, forged actor/timestamp input, append-only corrections, same-contact relationships, invalid values, upserts, retirement/deletion, audit visibility, and source-file privacy/preservation before and after linking. Eight behavioral subtests pass (nine tests including the wrapper).

PGlite uses real PostgreSQL role/RLS behavior with minimal local `auth` and `storage` fixtures. It does not exercise hosted Supabase Auth, JWT validation, Storage's HTTP service, signed URLs, concurrent upload races, or deployment configuration. Review those integrations in an authorized hosted environment before production use. Private source images should use short-lived signed URLs; an already-issued URL is not a substitute for current database authorization.

The implementation follows Supabase's requirement for [explicit API grants](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically), [RLS policies with both update checks](https://supabase.com/docs/guides/database/postgres/row-level-security), and [private-schema authorization helpers](https://supabase.com/docs/guides/api/securing-your-api). Security-definer helpers have an empty search path, revoked public execution, and only the required authenticated execution grants. No public-schema RPC grants access to the history.
