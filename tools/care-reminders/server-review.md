# Care follow-through — server package review

September 12, 2026 · Prepared source, disabled by default

When an explicitly bound care plan or guest task becomes due, the proposed
server layer creates one generic daily reminder per eligible email destination.
Pastor recipients are selected explicitly. They see overdue, unassigned,
unscheduled or unavailable-owner work; a three-calendar-day overdue occurrence
is deduplicated with the daily digest. Shared pastor/deacon email addresses
receive a single message. Completed, paused, inactive and removed work is excluded.

**Built and tested; not activated.** This step adds no recipient accounts, live
bindings, messages, hosted SQL, function deployment or schedule. The published
PR24/cachev20 app, Google Guest Register refresh and twelve applied migrations
remain the current operating baseline. Office reminder controls are the next step.

## Proposed database changes

Apply order is bindings, then queue. Both CLI-generated drafts remain under
`tools/care-reminders/migrations/`; [the package manifest](server-manifest.json)
records their exact hashes separately from the current twelve-file inventory.

Bindings store an explicit eligible Auth user, approval/source versions and a
durable cycle. Settings start disabled with an empty pastor list. Admin-only
settings/binding writes use expected versions and immutable request receipts.
Ordinary changes preserve a cycle; restarting requires an explicit action.
Guest ownership must agree with Intake actions and its current lifecycle.
Reassignment suppresses old routing; removal/restoration cannot reactivate it
silently. Linked one-time welcome plans are deduplicated only while their
association to the guest task remains valid. Deacon and Sunday school recurrence
remain independent, and attempted contacts do not restart a successful-contact
schedule. SQL dates are checked against the actual Office `dueFor` implementation.

The authoritative source helper derives dates/fingerprints from current care
plans and visits. It does not read Google Sheets or accept browser candidates.
Admin readiness exposes unbound sources, changed owners/lifecycles and unavailable
recipients. Capacity is bounded: 5,000 bindings/sources, 500 eligible staff and
20 explicit pastor identities. Missing/oversized projections fail with an error.
Unbound work is visible as a setup gap; it does not silently acquire a recipient.

The queue uses immutable daily/escalation occurrence keys, a unique active job
per normalized destination, row locks and fresh claim-time source/permission
checks. Pending, failed and uncertain work blocks another daily job. Leases last
120 seconds. An expired lease becomes an uncertainty hold, never a fresh send.
Normal retries retain the same job/provider key, with backoff, at most eight
attempts and a 23-hour window. A separate 20 first-attempt care-job cap per UTC
day preserves the existing welcome/initial-notice outbox and its budget.

All eight new private tables have RLS and no direct client/service access.
Privileged helpers have empty search paths and explicit grants. Enqueue, claim
and finish public RPCs are service-only. Configuration and the versioned
`cancel_no_resend` resolution RPC require a current eligible administrator.
The latter cancels held work without replaying its consumed occurrence. A
bounded administrative queue review/read screen remains to be implemented.

## Worker and delivery

The [worker guide](../../supabase/functions/care-reminder-dispatch/README.md)
describes authentication, fixed content, retry classes and required server keys.
It claims one job at a time, up to five per invocation. Browser origins and
caller-supplied recipients/content are rejected. Provider or database replies
must meet the expected contract; malformed success IDs cannot become accepted
receipts. The output contains only aggregate outcomes.

A message contains no member, guest, prayer or visit details. `accepted` means
provider acceptance durably recorded, not inbox delivery or a completed visit.
A transport timeout/ambiguous response requires operator review. Database claims
cannot eliminate an edit committed after a claim and before provider acceptance;
no lock spans the external request. No exactly-once delivery claim is made.

## Completed verification

- **15 binding tests:** admin/role boundaries, immutable/versioned requests,
  calendar-month and contact-history parity, capacity, removal/restart and source
  association. Existing functions, policies, accounts and initial outboxes stay intact.
- **24 queue tests:** RLS/ACLs, business hours/DST, daily/escalation and shared-address
  deduplication, source/recipient changes, leases, uncertainty holds, retry limits,
  quota and actual care/guest integrations.
- **27 transport tests:** authentication, fixed destinations/payloads, malformed
  requests/replies, provider failures/timeouts, exact retry bytes, bounded work,
  lost finish receipts and retry exhaustion.
- **3 full-path tests:** actual source projection/bindings/queue through the worker
  with an injected provider, including successful-contact suppression, guest
  removal before claim, and a durable uncertain-delivery hold.
- **22 existing planner tests** remain green. Total **91 distinct tests** verified:
  the 90-test combined run passed, then the final transport hardening passed all
  30 transport/integration tests (one new regression plus 29 rechecked tests).
- **6 actual PostgreSQL 17.6 checks** in a separate network-disabled container:
  eight concurrent enqueuers, eight concurrent claimers, competing finishers,
  a committed contact before claim, expired leases across days, and unchanged
  initial outboxes. SQL hashes match this package. Twelve baseline files were
  hash-verified; the native scheduler-extension-only file was not executed.
- **55/55 local release preflight checks** and Deno entry-point checking pass.
  This prepared clone has blank runtime Office config; that is not a report of
  the live site's configuration. Hosted services are outside these checks.

A first PostgreSQL harness run exposed a synthetic fixture missing its staff
identity; that setup was corrected, then all six checks passed in a fresh
container. The failed run was not reset to disguise it. These tests use fictional
records, simplified Auth/Storage SQL fixtures and mocked email. They do not prove
real Auth HTTP, inbox delivery, a live schedule, phone push or operator acceptance.

## Next release step

1. Add the Office recipient/settings and held-job review controls, including
   missing coverage, current versions, recovery from conflicts and clear paused
   versus enabled state. Rehearse them with fictional data.
2. Confirm the actual intended staff recipients and review the precise combined
   two-SQL/function/configuration activation package.
3. Perform one approved real delivery and an operator walkthrough before enabling
   a recurring schedule. Keep the original initial-intake notice workflow intact.
4. Add opt-in phone push as a separate channel after this email workflow is accepted.

Source branches remain stacked on `codex/care-reminder-foundation`. Do not merge
this source tree into the generated static Pages `main` branch.
