# Office attention — proposed read-only package

This package gives eligible Office admins and editors a complete list of intake and mail issues that need review. It only reads existing records. It does not send or retry mail, acknowledge issues, change recipients, complete tasks, add tables, schedule work or alter accounts. The active ten-migration manifest remains unchanged.

The installed Supabase CLI 2.117.0 generated `20260911132539_office_attention.sql` in a separate scratch project. The proposed migration adds just two functions: the public invoker `get_office_attention()` and its private definer. Both are `STABLE` with an empty search path. The private function uses the existing current-account staff eligibility check; anonymous callers, public app accounts, viewers, ineligible staff and the service role cannot call this projection.

## Response

`get_office_attention()` returns `{version:1,generated_at,today,waiting_minutes:30,total,items}`. `today` is a calendar date in `America/Chicago`; `generated_at` is the statement timestamp. The complete item list is read from the calling statement's snapshot, ordered by stable key. `total` equals `items.length`. A 5,001-item sentinel raises `OFFICE_ATTENTION_LIMIT_EXCEEDED` (`54000`), so the caller never receives a truncated list presented as complete.

Every item contains only `key`, `category`, `source_type`, `source_id`, `contact_id:null`, `care_role:null`, `title`, `owner_label`, `due_on` and `reasons`. Intake keys are `intake:<task UUID>`; welcome keys are `welcome:<registration UUID>`. Titles are generic. No prayer name, body, contact text, household data, notes, Auth identity, staff identity, email address or outbox identity is included. Source identifiers point to existing private Office tasks or registrations and do not establish a membership link. Care and personal leader reminders are separate Office projections.

## Reasons and ownership

One task yields one grouped item. Open tasks can show `intake_overdue`, `intake_due_today`, `intake_unassigned` or `recipient_setup`. A task with due/assignment/setup reasons has category `intake`; a task with only mail reasons has category `mail`. An Office queue task without an explicit staff recipient or deacon slot is unassigned. A deacon slot keeps the label `Deacon N` even when its resolved recipient needs setup. An explicit staff recipient is labeled `Assigned staff`. Actual eligibility is checked against the existing staff helper, without exposing recipient details.

`notice_attention` covers an attention job, a missing job for a current target, or no currently eligible targets. Current targets are resolved by the unchanged `private.intake_notice_targets` helper and matched using both staff UUID and normalized current email. Former recipients' jobs are ignored even when those jobs remain marked attention. The stored task notification summary is not treated as authoritative because eligibility and email may have changed since its last refresh.

`notice_waiting` covers a current target's queued job at least 30 minutes old, or a job that is at least 30 minutes old **and** has an expired sending lease. A retry scheduled for later still counts as aged waiting; the projection does not claim it is due for an immediate send. New jobs, current sending leases and sent jobs do not show waiting. Attention status is immediately reviewable regardless of age. Different current targets can produce both attention and waiting reasons on the same task.

Completed tasks never show due, assignment or setup reasons. An unresolved current-target notice can still produce a mail item, with an explicit `Completed guest follow-up` or `Completed private prayer care` title and `due_on:null`.

`welcome_attention` and `welcome_waiting` use the current welcome job status and the same waiting threshold. Welcome issues follow `app_welcome_links`: when multiple registrations share one deduplicated recipient job, each linked registration has one review item. This neither duplicates the job nor sends another message.

The 30-minute threshold is an Office review threshold, not a delivery promise. An empty list does not prove the scheduler, provider or inbox is working. No status here means delivered or read.

## Compatibility and verification

The active ten-file manifest and its SQL bytes are pinned in `manifest.json`. The function uses `to_jsonb(task)` to read the optional deacon slot, so the recorded baseline works before the proposed deacon migration is activated. Preference tables and RPCs are not dependencies. Both optional packages are also exercised together in compatibility tests.

With the existing locked test dependencies available:

```sh
node --test tools/office-attention/office-attention.test.mjs
```

The focused PGlite suite passed **21/21** tests. It applies the exact frozen eight migrations plus recorded intake; the infrastructure-only pg_cron/pg_net migration is byte-verified and not executed. Tests cover complete 5,000/5,001 boundaries, eligibility denials with positive controls, current and obsolete targets, email changes, zero/missing targets, privacy, completed tasks, waiting/lease rules, linked welcome deduplication and optional-package compatibility. Existing functions, owners, privileges, policies, roles, private schema ACL and bucket remain exact. Repeated reads preserve tasks, notices, welcome jobs, audit rows and quota, and the RPC succeeds in a read-only transaction.

`test-report.json` records the local scope. This pass makes no hosted, Auth API, delivery, phone or scheduler acceptance claim. No real PostgreSQL concurrency rehearsal was needed for this read-only projection.

Current official guidance was checked September 11, 2026: [Supabase changelog](https://supabase.com/changelog), [function security and privileges](https://supabase.com/docs/guides/database/functions), and [row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security). The relevant function/private-schema guidance is preserved; the changelog's management-log and extension-version changes do not affect this package.
