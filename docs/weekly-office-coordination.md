# This week in Creek Office

This is a private, read-only view for eligible administrators and editors. It gathers existing saved records without adding a second task list or changing database tables. It does not publish content, assign people, send messages or record an acknowledgement.

The view uses the current Monday–Sunday in America/Chicago. Sunday means the coming Sunday within that week, including today when opened on Sunday. It shows:

- Draft and ready announcements whose dates overlap the week. Undated announcements remain visible with their dates missing, so they are not silently treated as current approved copy.
- Slide records for that Sunday, separating preparation status from whether a valid deck link or currently listed document is attached. A link is not evidence that its permissions or contents have been tested.
- Non-archived staff events overlapping the week. These private Office events are separate from the public iCloud calendar.
- Active committee records whose term has expired or ends within thirty Central calendar days. Open the original record to confirm whether the term or roster should change.

Every action opens its original editor. Navigation occurs only when that editor actually accepts the action; cancellation, an uncertain save, an unavailable record or a changed staff session leaves the current view in place. Saving uses the existing version/conflict/retry rules. An open view never completes work.

The content projection returns only IDs, titles or committee names, dates, preparation status and slide-material presence. It excludes announcement bodies, deck URLs, contact names and details, prayer requests, staff notes and personal leader follow-ups. Display filters in the original tables do not change the shared view's source inventory. Each source has an explicit available/unavailable state; incomplete data never becomes a zero or an all-clear.

No weekly content is stored in browser localStorage or exported. Refresh tokens protect against older refresh completions. Sign-out, role/owner/epoch change and a paused workspace clear or block the weekly content. A current successful workspace refresh is required before its source actions can run.

## What still needs to be built or agreed

This view provides shared visibility. It does not yet provide structured owner/backup fields, a Sunday approval record, an acknowledgement log, overdue escalation or a weekly digest. Existing ready status means prepared for staff use; it does not represent publication approval. The separate Needs attention view covers intake, recurring care and the signed-in owner's leader work.

Recommended next operating decisions: choose primary and backup reviewers for intake, Sunday content, membership, calendar, access and recovery; agree a weekly review time and a Sunday copy cutoff; define the evidence for an actual completed contact. These are proposals for church approval, not new policy.

## Acceptance

Local tests must cover Central date boundaries, source completeness, minimal copied projections, script-like text, private-role/owner/epoch changes, overlapping refreshes and refused source actions. Real acceptance requires two approved staff members to open the same saved week, edit an original record and observe that exact saved change after refreshing. Neither local tests nor a draft PR counts as that hosted acceptance.

The feature is prepared on a development branch. No live publication, schema change or account action is implied by this document. Keep development source out of the static Pages main branch.
