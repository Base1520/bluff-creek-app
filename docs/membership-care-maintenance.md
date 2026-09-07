# Membership history, guests and deacon care

Creek Office now has a working interface and a prepared private database migration for long-term membership history and care follow-up. It is still a feature-branch proposal: no live staff backend, Google Sheets write-back, OCR service, or external reminder delivery has been activated.

## Source of truth and the existing Google ledger

The church's duplicated Google Sheet remains the working ledger until its current file and access are verified and an import/reconciliation is approved. Earlier handoff notes record 243 imported rows; the user now estimates about 600 names and 70 years of history. These are different scope claims, not a verified count of the live file. Do not treat 243 rows as the complete archive, discard historical/inactive names, or replace the original roll.

The saved duplicate's metadata request returned permission denied. The user offered to sign in with the correct Google account. Browser inspection confirmed that account was already signed in but the saved duplicate still denied access. Drive search found the original roll; automatic approval review rejected opening that original because the requested source was the duplicate. No original membership contents were read, exported, imported or changed. The user must open the intended copied sheet or supply its export. Account identifiers and member contents do not belong in this document or the repository.

`admin/config.js` supports `membershipSheetUrl`, initially blank. After the duplicate is verified, this can point staff to its private Google Sheets edit page. Google permissions continue to govern it. This link is not synchronization: the history screen and success message explicitly say office edits do not write to Google. Do not publish the membership sheet as CSV to make browser access easier.

Before any data migration: inventory exact tabs/headers and row counts; retain original MemberID and membership numbers; reconcile duplicate identities and spelling variants against source pages; count active, inactive and uncertain rows; compare input/output counts; resolve exceptions with the church. A first-time guest is not automatically a member. No real member data has been seeded into app code, screenshots, tests, the vault or this handoff.

## People and historical records

People records now include existing ledger IDs, membership numbers, middle/preferred/former names, household and contact details, historical date text, ways received, removal reasons, and a source-review flag. New records start needing review. Names can retain an unknown surname as blank. Dates such as “summer 1956” or unclear handwriting remain text; a verified exact date is optional in history entries.

Search covers names/variants, member identifiers, household, phone and email. People, documents and history reads page through results with a unique ID as a sorting tie-breaker, rather than silently stopping at the backend's default 1,000 rows. History search covers the loaded entries, dates, details and source labels; the display shows 100 matches at a time with a notice to narrow the search. The member's **History** button filters their entries.

History entries append to a person. Corrections append a new entry linked to the earlier entry and retain its source. The migration blocks ordinary SQL deletion of people and alteration/removal of history/visits. Archive people by changing their current status, keeping historical membership events. This is preservation within the application, not a substitute for an independently verified backup/restore procedure; privileged database operators can override safeguards.

## Handwritten pages

1. Add or identify the person in People. Preserve the original identity and spelling; do not merge on name alone.
2. In Member history choose **Add history / page photo**. On a phone, the image input can use its camera. JPEG, PNG and WebP are accepted up to 15 MB; convert HEIC first if needed.
3. Attach the original page or select an existing private source document. Record its book/page reference. Transcribe the wording and mark uncertain letters/dates with `[unclear]`; do not guess missing facts. Several people on one page can reference the same original document.
4. Check the transcription against the image and tick the review checkbox before saving. The original image uses private `church-documents` storage under the reserved `USER-ID/membership-history/` prefix, with generated filenames. That prefix denies viewer access from the start of upload, before a history row exists.
5. A source linked to history is protected against ordinary staff replacement, path changes and deletion. Opening it generates a short-lived private link. Corrections retain earlier entries and their evidence.

Photo upload does not currently run OCR or add rows to Google Sheets. The user may supply photographed pages for assisted transcription once the private destination is accessible; uncertain readings still need review. A future OCR integration should produce a draft/review queue, retain source-page links and require confirmation before ledger writes. Do not send private photos to an unapproved external service or commit them to the repository.

Upload, document metadata and history insertion are separate operations. Session/closed-review guards prevent follow-on work after invalidation. A failed/uncertain request can leave an unlinked private object/document; it is retained rather than risking loss of an original. Review these objects through an approved cleanup process. A retained document can be selected when retrying. Network-uncertain insert outcomes need reconciliation before repeating an entry; no exactly-once import guarantee is claimed.

## Guests and deacon care

**Guests** records the first visit, current next step, status, optional next follow-up date and notes for an existing person. Create their person as `visitor`; linking a guest intake does not change membership status.

**Care plans** assign a deacon/display name to a person, choose a contact interval and start date, and allow a pause. The initial 28 days is an editable starting suggestion, not an adopted church policy. Assignments do not create logins or grant access to records.

**Visits and contacts** records who visited/called, the date, method, whether contact succeeded or was only attempted, notes, and an optional explicit next date. Contact history is append-only. Keep notes concise and relevant to the agreed ministry purpose; general People notes remain visible to all approved staff roles, while these care/history tables are restricted to admin/editor.

**Follow-up** uses the most recent visit's explicit next date when present. Otherwise it uses the latest successful contact plus the plan interval, or the plan's start date plus the interval when nobody has been reached. An attempted call does not reset successful-contact age. Paused plans are omitted from the due queue but remain editable. Dates use America/Chicago and remain correct across daylight-saving transitions. Assigned-name and text filters help staff find their list.

This is an on-screen due/overdue queue, recalculated from saved records. It does not send email/text/push reminders or make calls. An approved delivery channel, staff recipients and notification policy are needed before external reminders can be enabled. No recurring Codex automation or message delivery was created.

**Guidelines** has no seeded official policy. The screen labels starter guidance as proposed until an administrator saves the church's actual guidelines. Editors can read them; only admins can revise them. The existing first-time guest sheet and deacon guidelines are still requested from the user.

## Activation and verification

After separate church-backend authorization, apply the base `supabase/schema.sql` and then `supabase/migrations/20260907_membership_care.sql`; see [schema details](membership-schema.md). Verify real hosted staff roles, revocation, source-image access and uploads before any real records. Current roles are admin/editor/viewer; there is no assigned-deacon-only login role in this phase. Do not invite all deacons as broad editors without an explicit access decision.

Run `npm --prefix admin/tests test` for care dates, session races, history/photo review and real local PostgreSQL policies, plus `node --test tests/*.test.cjs` for the public app. Local samples and mock storage prove interface behavior, not hosted authorization or actual Google synchronization. Preserve the existing public app, calendar and private service-worker exclusions.
