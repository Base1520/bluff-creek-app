# Office care reminder controls — prepared, not activated

Administrators can review missing care setup, select real staff recipients, pause
the reminder service, and inspect failed or uncertain delivery jobs. Guest email
routing follows the owner saved in Intake actions. Ordinary care recipients are
explicit account bindings; a recorded owner name never becomes email authority.

The Office dashboard summarizes service state, missing setup and delivery review.
Unavailable or incomplete reads display unavailable counts. Editors and viewers
cannot load these controls. Opening the original record requires its existing
Intake or care module to accept the record first.

## What is in this change

- `admin/care-reminders.js` and its scoped Homestead stylesheet; minimal Office
  navigation, dashboard, session cleanup and module lifecycle hooks.
- A third proposed SQL draft,
  `20260912224640_care_reminder_controls.sql`, adds two admin-only read RPCs:
  `get_care_reminder_workspace` and `get_care_reminder_jobs`. Each public invoker
  calls an admin-checked private definer with an empty search path. No table,
  policy, old function, source record, binding, recipient or delivery is changed.
- Each RPC uses one statement snapshot. Jobs use a bounded keyset page. The UI
  rejects incomplete results and refreshes when counts drift across pages; this
  is not a promise of one snapshot spanning several browser requests.
- The screen uses existing versioned settings, binding and cancellation RPCs.
  A timeout keeps the exact request UUID and payload. Only the same save may be
  retried until its receipt is resolved. Role/account changes clear private DOM;
  connection pauses hide it and preserve same-session drafts in memory.
- A restored guest needs explicit lifecycle review before a new reminder cycle.
  Linked welcome tasks must belong to the same person. Cancellation is explicitly
  **without resend** and never records a visit or completes a care task. A held
  destination may become eligible in a later cycle after review.

The browser never dispatches email, accesses a service credential, or persists
these private records in browser storage. Provider acceptance is distinct from
inbox delivery. A service pause cannot withdraw mail already in flight.

## Verification

Final local checks: **55/55 SQL tests** (15 bindings, 24 queue, 16 controls),
**28/28 reminder UI tests**, and **101/101 Office session tests** (including five
new integration tests). The controls SQL tests verify grants, immediate role
revocation, bounded projection/pagination, missing/removed records, source owner
drift, complete counts, and preservation of baseline rows, functions and policies.

The UI review reproduced and fixed account changes between readiness and queued
RPC dispatch, identity changes in discard dialogs, paused late receipts, malformed
UUID-shaped arrays, nullable missing sources and incomplete delivery pages. The
original failing cases remain in the test suite. Browser checks use a separate
fictional fixture, with no Auth client, live backend or outbound email: desktop
and 390px phone layout, original-record opening, a saved guest setup receipt,
zero horizontal overflow, zero external requests and no page errors.

These are synthetic/local checks, not hosted Auth, live scheduler, inbox,
phone-notification or production recovery acceptance. The prior server package's
six isolated PostgreSQL concurrency checks remain separate historical evidence.

## Release order and boundaries

This source branch is stacked on `codex/care-reminder-queue` (PR26 at
`4b55cd803bfd03242f24ec8c8f20aa5eb088851b`). Do not merge this source stack into
static Pages main. Port only the new controls and minimal Office hooks onto the current PR24 baseline
`308e9987d69f1c8ff6365e5c39d194586537ab20`; preserve public app, worker, CNAME,
signup, recovery and Guest Register behavior. The static candidate also needs a
narrow boolean-result compatibility fix in its existing Intake open helper; do
not replace that module with the unrelated pending source version.

The exact proposed SQL order is **bindings → queue → controls**. All three remain
under `tools/care-reminders/migrations`, outside the active twelve-file inventory.
`server-manifest.json` records their hashes. Settings default disabled, with no
pastor recipients. No live migration, function, schedule, binding or email was
activated while building this change.

Before activation, reconcile current hosted migration versions, review the exact
worker/configuration/static package, select actual eligible recipients, and use
a narrowly approved delivery rehearsal before enabling the schedule. Keep
existing welcome and first-intake outboxes unchanged. Deacon rotation, Needs
attention, shared weekly content, weekly bulk email and phone push remain
separate prepared/future work.
