# Care reminder planning foundation

This is a **local, dry-run planning tool**, not an activated reminder service. It produces a reviewable set of generic email plans from a complete, current, server-shaped snapshot. It does not query a database, write a queue, send a message, schedule a job, change a role, subscribe a device or alter the public app. Every result is marked `dry_run:true`.

The goal is to make overdue care visible to both the responsible staff member and the pastor without treating a display label as an email recipient, duplicating a shared address, or notifying staff about a completed/removed visit.

## Current behavior

- `careSource` reuses the existing Office `dueFor` function. Contact attempts, explicit next dates, separate care roles, one-time completion and calendar-month arithmetic retain the same meaning as the Office screen. New visits affect the review fingerprint even if the plan version has not changed.
- `guestSource` excludes removed tasks and removed/archived registrations. A restored registration remains inactive for reminders when its lifecycle version no longer matches the explicitly approved reminder binding.
- An initial welcome plan with an explicit link to a guest Intake action is represented only by that action. This does not suppress independent ongoing care plans.
- Assigned eligible staff receive due/overdue items. Explicitly selected eligible pastor identities receive overdue, unassigned, unscheduled and unavailable-recipient items. Pastor status is not inferred from all administrators or an email address.
- Proposed operating defaults are 9 a.m.–5 p.m. America/Chicago, one daily digest, and an additional occurrence for items at least three calendar days overdue. If daily and escalation occurrences are eligible together, they share one message plan per destination. The planner emits today's digest only, without replaying missed historical days.
- Identical pastor/deacon email destinations combine into one plan. Destination keys must be server-issued opaque registry hashes, not addresses. Existing initial-assignment email jobs remain separate and are never reset by this tool.
- Failed and uncertain receipt states hold that destination across day changes. Changing a cosmetic record version, rearranging input, retrying the planner or advancing the calendar does not authorize another send around that hold. An operator-controlled resolution is required in the future queue layer.
- Queued or sending receipts also block a newer digest for that destination, including on the next day. Ordinary pending work is not labeled a delivery failure. The durable queue must resolve or explicitly cancel that work before a newer daily plan can proceed.
- Missing, malformed, oversized, stale or incomplete snapshots return a blocked result with `counts:null`; unavailable data is never presented as an empty successful review. The accepted freshness window is five minutes, with at most thirty seconds of forward clock skew.
- The generic notification body contains no guest name, prayer text, email, address, child details or contact notes. It points to the fixed private Office care route. Internal source references are private review metadata and must not be copied into public push payloads or shared logs.

## Contracts

Run the tests with the system Node runtime; no new dependency is required:

```sh
node --test tools/care-reminders/planner.test.mjs
```

`careSource({plan,visits,person,binding,linkedGuestTask}, today)` accepts actual Office-shaped care data and a proposed explicit binding. `guestSource({task,registration,binding})` accepts a guest task and its matching registration. The caller must not swallow an adapter error and substitute an empty list. The underlying complete reads and role checks must happen on the server in one coherent snapshot.

The binding contract includes source type and ID, a positive version, an approved flag, enabled flag, recipient user ID (or explicit null), and a durable cycle UUID. Guest bindings additionally record the registration lifecycle version under which the notification cycle was approved. **These binding/cycle records do not exist in the currently live schema.** They require a separately reviewed server implementation. A fabricated browser flag is not authorization.

`planReminders(snapshot, nowISO)` requires:

- `version:1`, `complete:true`, a current `generated_at` timestamp;
- `sources`: normalized source type, ID, cycle ID, review revision hash, due date, state and explicitly bound owner ID;
- `recipients`: user ID, fresh eligibility and role, and enabled email destination hashes;
- `pastor_user_ids`: explicitly configured recipients for pastoral review;
- `receipts`: complete occurrence keys, channel, destination hash and current delivery state;
- `holds`: persistent destination holds for unresolved delivery or operator pause.

The snapshot is an input contract, not an implemented database endpoint. Its eligibility/complete fields are assertions that must come from the future authenticated server adapter. The result cannot be used as a permission grant.

`compareFreshPlan(candidate, freshSnapshot, nowISO)` recomputes the exact plan including its payload, recipient destinations, source revisions and occurrence set. Completion, new contacts, removal, changed ownership, disabled recipients, resolved dates and changed payloads invalidate an old review. **This comparison is not an atomic send claim** and cannot prevent a change after it returns.

## Remaining implementation before any live mail

1. Review and implement explicit recipient bindings and durable cycle records; decide how a staff member deliberately reopens or reschedules a cycle. Keep current-account eligibility equivalent to the existing confirmed, nonanonymous, nondeleted, nonbanned admin/editor checks.
2. Build a complete server snapshot over authoritative tasks/plans/visits and lifecycle state. Scope its privileges and read volume; missing/failed reads must stop the job. The Google mirror and browser-loaded list are not authoritative sources.
3. Add transactionally unique occurrence rows and leases. Record every included daily/escalation occurrence atomically, deduplicate shared destinations, and recheck current permission, assignment, completion, contact history and removal before sending. Handle completion/removal versus send races using a reviewed locking/claim protocol.
4. Persist delivery receipts and ambiguous-send holds, use bounded retry/provider-idempotency behavior, expose failures and operator resolution in Office, and preserve the existing welcome budget and jobs.
5. Restage any needed deacon/Needs attention packages on PR24. The older attention projection must not be used without the dependent removed-record compatibility correction.
6. Test actual PostgreSQL concurrency, permissions and a narrowly scoped approved delivery. Only then prepare/activate the exact migrations, function and schedule. Local deterministic tests do not establish production delivery or exactly-once mail.

Push is a later channel: opt-in UX, per-device subscriptions, revocation, safe provider endpoints, server-held VAPID credentials, notifications/click handlers and real-phone acceptance are not implemented here. No public or staff push notification is sent by this package.
