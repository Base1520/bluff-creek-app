# Care reminders — planner and prepared server queue

The planner described below is a **local, dry-run planning tool**, not an activated reminder service. It produces a reviewable set of generic email plans from a complete, current, server-shaped snapshot. It does not query a database, write a queue, send a message, schedule a job, change a role, subscribe a device or alter the public app. Every result is marked `dry_run:true`.

A separate **server package is now implemented and locally tested**: explicit
staff bindings, authoritative due-date projection, a durable occurrence/claim
queue and an email worker. The three SQL drafts stay outside the active migration
inventory, settings default disabled, and no delivery schedule is installed.
See [the server review](server-review.md) and [worker guide](../../supabase/functions/care-reminder-dispatch/README.md).
The server computes its own candidates; it never accepts browser planner output
as permission to send. The planner's snapshot JSON remains a review contract,
not a public database endpoint.

The goal is to make overdue care visible to both the responsible staff member and the pastor without treating a display label as an email recipient, duplicating a shared address, or notifying staff about a completed/removed visit.

## Current behavior

- `careSource` reuses the existing Office `dueFor` function. Contact attempts, explicit next dates, separate care roles, one-time completion and calendar-month arithmetic retain the same meaning as the Office screen. New visits affect the review fingerprint even if the plan version has not changed.
- `guestSource` excludes removed tasks and removed/archived registrations. A restored registration remains inactive for reminders when its lifecycle version no longer matches the explicitly approved reminder binding.
- An initial welcome plan with an explicit link to a guest Intake action is represented only by that action. This does not suppress independent ongoing care plans.
- Assigned eligible staff receive due/overdue items. Explicitly selected eligible pastor identities receive overdue, unassigned, unscheduled and unavailable-recipient items. Pastor status is not inferred from all administrators or an email address.
- Proposed operating defaults are 9 a.m.–5 p.m. America/Chicago, one daily digest, and an additional occurrence for items at least three calendar days overdue. If daily and escalation occurrences are eligible together, they share one message plan per destination. The planner emits today's digest only, without replaying missed historical days.
- Identical pastor/deacon email destinations combine into one plan. Destination keys must be server-issued opaque registry hashes, not addresses. Existing initial-assignment email jobs remain separate and are never reset by this tool.
- Failed and uncertain receipt states hold that destination across day changes. Changing a cosmetic record version, rearranging input, retrying the planner or advancing the calendar does not authorize another send around that hold. The prepared queue has a versioned administrator cancellation/resolution RPC; its administrator Office review screen is implemented in this source branch and remains unpublished.
- Queued or sending receipts also block a newer digest for that destination, including on the next day. Ordinary pending work is not labeled a delivery failure. The prepared durable queue must resolve or explicitly cancel that work before a newer daily plan can proceed.
- Missing, malformed, oversized, stale or incomplete snapshots return a blocked result with `counts:null`; unavailable data is never presented as an empty successful review. The accepted freshness window is five minutes, with at most thirty seconds of forward clock skew.
- The generic notification body contains no guest name, prayer text, email, address, child details or contact notes. It points to the fixed private Office care route. Internal source references are private review metadata and must not be copied into public push payloads or shared logs.

## Contracts

Run the tests with the system Node runtime; no new dependency is required:

```sh
node --test tools/care-reminders/planner.test.mjs
```

`careSource({plan,visits,person,binding,linkedGuestTask}, today)` accepts actual Office-shaped care data and a proposed explicit binding. `guestSource({task,registration,binding})` accepts a guest task and its matching registration. The caller must not swallow an adapter error and substitute an empty list. The underlying complete reads and role checks must happen on the server in one coherent snapshot.

The binding contract includes source type and ID, a positive version, an approved flag, enabled flag, recipient user ID (or explicit null), and a durable cycle UUID. Guest bindings additionally record the registration lifecycle version under which the notification cycle was approved. **These binding/cycle records do not exist in the currently live schema.** Their implementation is in the first two proposed SQL files and still awaits the combined activation review. A fabricated browser flag is not authorization.

`planReminders(snapshot, nowISO)` requires:

- `version:1`, `complete:true`, a current `generated_at` timestamp;
- `sources`: normalized source type, ID, cycle ID, review revision hash, due date, state and explicitly bound owner ID;
- `recipients`: user ID, fresh eligibility and role, and enabled email destination hashes;
- `pastor_user_ids`: explicitly configured recipients for pastoral review;
- `receipts`: complete occurrence keys, channel, destination hash and current delivery state;
- `holds`: persistent destination holds for unresolved delivery or operator pause.

The snapshot is an input contract, not an implemented database endpoint. Its eligibility/complete fields are assertions that must come from the authenticated server implementation. The result cannot be used as a permission grant.

`compareFreshPlan(candidate, freshSnapshot, nowISO)` recomputes the exact plan including its payload, recipient destinations, source revisions and occurrence set. Completion, new contacts, removal, changed ownership, disabled recipients, resolved dates and changed payloads invalidate an old review. **This comparison is not an atomic send claim** and cannot prevent a change after it returns.

## Remaining before live care reminders

1. Publish the narrowly restaged Office controls after reviewing the exact
   three-migration package. The source implementation now selects explicit
   recipients, reviews unbound/changed sources and held jobs, pauses the service,
   and resolves uncertain saves by replaying the exact request. See
   [controls review](controls-review.md). No staff bindings are activated.
2. Review the actual intended recipients and operator workflow. Guest ownership
   must match Intake actions; ordinary care display labels alone grant no email
   authority. A restored guest requires explicit lifecycle/cycle approval.
3. Review the exact three-SQL/function package and deployment configuration, then
   activate with a narrowly scoped approved delivery and schedule. The current
   twelve applied migrations are unchanged. Local PostgreSQL concurrency and
   mocked delivery tests do not establish real inbox delivery.
4. Restage compatible deacon/Needs attention work on PR24. Do not activate the
   older removed-record projection or reset existing initial-assignment jobs.

Push remains a later channel: opt-in choices, device subscriptions/revocation,
server-held VAPID credentials, safe provider endpoints, notification/click
handlers and real-phone acceptance. This package sends no public or staff push.
