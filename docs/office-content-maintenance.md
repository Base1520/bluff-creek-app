# Announcements, committees, Sunday slides and prayer requests

Creek Office adds four sidebar destinations using the existing Homestead identity. These are private staff editing tools on the feature branch. The church backend is still unconfigured; local review uses synthetic records in browser memory.

## Daily use

- **Announcements:** create or edit a title, message, optional start/end dates and draft/ready/archived status. Ready means prepared for staff use. It does not publish to the public website/app, create a social post or send a message. Dates are planning fields, not an activated publishing schedule.
- **Committee contacts:** keep the committee name, contact person, role, phone/email, optional term dates and notes together. Search and mark past contacts inactive rather than deleting them. A committee assignment does not create account access or contact anyone.
- **Sunday slides:** organize a slide deck by service date, title and preparation status. Link an existing HTTPS deck, such as a Google Slides or Canva presentation, or select a file already in Documents. Use Upload slides to add a PowerPoint/PDF or other file through the existing private uploader, then attach it to a slide record. A ready record needs a deck link or file. External deck permissions remain with the hosting service. This is a deck library; it does not generate presentation artwork or remotely edit a slide deck.
- **Prayer requests:** manually add or edit the display name, request wording, separate care notes and active/answered/archived status. Staff-only is the default. Recording prayer-team/church sharing permission requires an explicit approval checkbox. This records permission; it does not publish or send the request, and it does not change which office roles can read the record. The current public prayer form opens an email draft, so submissions are not automatically received here.

All four screens support search and status filters. Existing records remain available after archival/inactivation. Input renders as text; slide links allow only HTTPS URLs without embedded credentials. No new screen reads or writes browser storage. Signing out or switching accounts clears records and open editing dialogs.

## Access and activation

All four tables and their audit metadata are restricted to current admin/editor staff roles. Viewers, anonymous visitors and unapproved accounts are denied. The sidebar and route guards reflect this rule, while database grants and row-level policies enforce it. Care notes remain private even when a prayer record's sharing permission is marked church-wide; any later publication workflow must explicitly select approved request wording and exclude care notes.

After authorized church-owned backend setup, apply the base schema, the membership/care migration, then `supabase/migrations/20260907_office_content.sql`. See [schema contracts](office-content-schema.md). Keep current configuration blank until activation is approved. No existing committee lists, prayer requests or private decks were imported into code or the preview.

The migration stamps creation/update actors and timestamps in the database and uses the existing metadata-only audit log. Client delete is not granted. Updates preserve record identity and creation metadata. General document access rules still apply to files attached to slide records; their attachment does not turn them into immutable historical source pages. External deck links are not a substitute for the external provider's permissions.

## Verification

The staff test suite exercises the new SQL constraints/roles, client validation, editing, links, pagination and stale sessions with synthetic data. Integrated browser review covers desktop and narrow phones, all sidebar routes, scrollable navigation/sign-out, the four edit workflows, and absence of private requests after sign-out. Local checks do not verify a hosted database, real file download, external deck permissions or message delivery. No public feed, deployment or account change is included.
