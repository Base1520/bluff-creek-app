# Shared weekly email preparation

Staff can save one weekly message, select announcement revisions, review its saved wording, and see current communication-choice counts. This is a content preparation workflow. It does not send, schedule, export or approve the delivery of a campaign.

## Office workflow

1. Open **Weekly email** and choose a Monday. Create a draft or open one saved for that week.
2. Write the subject, introduction and closing. Explicitly select ready announcements and check their wording and dates. Ready means prepared for staff use; it is not automatic permission to publish.
3. **Save to Office** and check the saved preview. The server captures the selected announcement revisions, rather than trusting announcement text supplied by the browser.
4. An administrator reviews the saved preview and marks its content reviewed. Editors can draft, but cannot record this review.
5. A draft edit resets its review. An announcement change makes the saved source review stale. Reselect current sources and save before reviewing again.

The current audience is a count of saved choices, held addresses and excluded/no-choice records. It is not a recipient reservation, verified email ownership, provider suppression check or permission to send later without rechecking.

## Private state and recovery

New private tables store draft state, immutable revision snapshots and request receipts. Only eligible administrators/editors can use the guarded read/save entrypoints; only administrators can review. No recipient list, prayer record, household profile, staff calendar event or committee note is copied into these tables. Message copy is intended for public use but remains private inside Office until a separately authorized publishing workflow exists.

Saves and reviews use an expected draft version plus a per-actor request UUID. Identical retries return their original receipts; a reused request ID with different content or operation conflicts. A changed source or stale draft cannot overwrite current work silently. A private write guard serializes the low-volume draft operations and enforces at most 20 drafts per week, including moves between weeks. Source candidates are complete for the selected week or fail visibly above the explicit limit.

When a write times out, keep its exact request and body. Checking the current record is useful, but an absent or newer read does not prove the earlier write failed. After the deadline, explicitly retry the same request to obtain its receipt, even if the earlier connection remains unresolved. No fresh request ID or automatic retry is introduced. A later refused retry does not settle an earlier uncertain submission; the original request remains frozen until its receipt is confirmed. This browser state is temporary recovery assistance, not a backup. Same-session connection pauses hide private content and freeze the draft in memory; restored readiness can resume it. Sign-out or changed identity/role discards private draft state.

## Deployment boundary

The proposed SQL is under `tools/weekly-email/migrations/`. Its filename was created by the Supabase CLI. It depends on the recorded Office/direct-intake baseline and the separately prepared communication-preferences projection. It does not alter the active ten-migration inventory, manifest, any existing policy/helper, worker, scheduler or account. Existing source/static release branches retain their own review order. Never merge the development source into static Pages main.

After a separately authorized migration, test staff roles, saved/reviewed/stale states and uncertain-request recovery against the actual service before relying on the module. A missing backend exposes a clear unavailable state and leaves the other Office sections usable. Local tests do not establish a successful real staff login or production delivery.

## Remaining delivery work

- Signed unsubscribe handling, current purpose-specific preferences and provider suppression feedback.
- Sender identity and permitted sending volume; church-owned credentials stay server-side.
- A separately reviewed campaign revision and recipient plan, followed by fresh eligibility checks before each dispatch.
- Durable per-recipient jobs and stable provider idempotency keys, with bounded uncertain-result recovery and explicit needs-attention states.
- Verified delivery/bounce/complaint feedback and authorized real-inbox acceptance.

Content review here must never be consumed directly as permission for automatic sending. Keep the existing church communications process available until that later workflow is accepted.

Primary implementation guidance checked: [Supabase database functions](https://supabase.com/docs/guides/database/functions), including explicit function execution privileges and an empty search path for privileged functions. The separately planned sender must respect the provider's [idempotency behavior](https://resend.com/docs/dashboard/emails/idempotency-keys); no provider API or SDK is introduced by this feature.
