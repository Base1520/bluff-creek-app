# Guest registration removal — optional review package

This package prepares a reversible **Remove guest visit** / **Restore guest visit** operation on the existing ten-migration Office baseline. It does not apply itself, change the active migration manifest, or contain a real registration identifier. The source file was generated with `supabase migration new guest_registration_lifecycle`; its generated timestamp is retained.

## Exact scope

Removal hides the app registration and its intake follow-up from active register/action views. It preserves the Auth account, linked People record, every care plan and visit, membership history, prayers, original intake receipts, and already accepted mail jobs. A linked welcome care plan has no registration provenance FK and may be shared; it must **not** be silently paused or deleted. The confirmation dialog must explain these separate records remain.

The registration gets `guest_removed_at`, `guest_removed_by`, and an incremented `guest_lifecycle_version`; its existing status becomes `archived`. Previous registration status and task status/completion fields are retained in private lifecycle state. The task gets `guest_removed_at`, an incremented version and a stored completed status while removed. The removal marker is authoritative: the UI must label and filter it as **Removed**, not count it as completed care. This keeps the existing task check constraints and future deacon open-task propagation safe. Restore reinstates the exact prior status/completion fields, preserves due date/recipient/slot, and changes neither the rotation cursor nor membership records.

## RPC / UI contract

* `get_guest_lifecycle_readiness()` returns `{version:1, available:true}` to eligible admin/editor staff. Feature absence hides removal controls; an unavailable read cannot imply an empty register.
* Admin-only `set_guest_registration_removed(p_request_id uuid, p_id uuid, p_version integer, p_staff_version integer, p_lifecycle_version integer, p_removed boolean)` returns `{id, version, staff_version, lifecycle_version, removed, task_id, task_version}`. Task fields can be null for a historical registration with no intake task.
* `p_lifecycle_version` comes from the row's `guest_lifecycle_version`, initially 1. Every archive/restore increments lifecycle and staff versions; profile version is unchanged because the person's supplied information has not changed.
* Freeze the request UUID and all arguments on uncertain submission. Exact retry returns its original immutable receipt, even after a later opposite operation. Then read current rows before presenting current state. Replayed receipts do not undo later work.
* `40001/GUEST_LIFECYCLE_VERSION_CONFLICT` means reload before a new action; `40001/GUEST_LIFECYCLE_REQUEST_CONFLICT` means that UUID was used with different arguments. Neither disproves an earlier committed attempt.
* `55P03/GUEST_DISPATCH_BUSY` means a needed row or an active send lease is busy; no lifecycle changes committed. Retain the draft and explicitly retry later.
* `55000/GUEST_REMOVED` blocks older registration, review, staff follow-up, and task mutation paths from silently reactivating a removed source. The own-profile getter adds only `guest_removed:boolean`; it does not expose removal actor or staff metadata. Historical registration receipts remain readable/replayable.
* Restore never sends, retries, or creates email. It does not unsubscribe someone or erase their separate weekly-email choice.
* A pre-existing `status=archived` row without this package's removal state is refused as `GUEST_LIFECYCLE_STATE_UNAVAILABLE`; its unknown prior state is not guessed or backfilled.

## Notification limits and locking

The transaction locks the eligible acting account, then attempts the source account, registration, task and associated outbox rows using `NOWAIT`. It refuses an active sending lease. Queued or expired-lease unsent jobs are moved to attention with `guest_removed`, without resetting attempt history or provider deduplication identifiers. Previously sent jobs remain byte-for-byte unchanged.

A welcome job can serve more than one registration sharing a recipient. Removal permanently suppresses that registration's welcome link; the job stays available to another active, unsuppressed link. The welcome claim helper checks this condition for both scheduled and account-scoped dispatch. Restore does not uncancel the link. Staff notice target resolution excludes removed tasks, so future recipient discovery cannot enqueue notices while removed.

An expired lease is not proof a provider request never escaped PostgreSQL. Removal stops future claims and invalidates stale finishes; it cannot recall already accepted or in-flight email. No provider or delivery test is claimed here.

## Current and later UI / feature compatibility

The current register must exclude `guest_removed_at != null` from active, awaiting-review, reviewed, export, and summary views, and offer a separate Removed view. Intake lists/counts/source lookups must exclude task `guest_removed_at != null`, including their Completed filter. A removed registration may remain privately inspectable for restoration. Editors may read that state but cannot remove/restore; eligible admins can.

The already proposed deacon migration does not need rewriting: it skips completed task rows, so it will not propagate recipient changes into removed actions. The removed-task trigger also prevents direct reopening. Its original SQL bytes and approvals remain unchanged.

Before activating the separately proposed Needs attention / weekly preference audience packages, apply a separately reviewed compatibility change: their SQL currently includes archived/removed registrations, and the attention query includes notification problems even for completed tasks. `get_office_attention` must exclude marked tasks and marked registration welcome links; `get_office_communication_audience` must exclude archived/removed registrations before counts and duplicate-email classification. That compatibility update is not silently bundled or applied here. The current ten-file baseline has neither RPC.

## Verification

Run `node --test tools/guest-lifecycle/guest-lifecycle.test.mjs`. Fictional PGlite fixtures verify all ten baseline file hashes and execute the nine functional SQL files. The tenth file only installs native `pg_cron`/`pg_net`, unavailable in PGlite; its hash is checked but its extension-install statements are not run. No test sends email or reaches a hosted database.

Required independent PostgreSQL concurrency checks before hosted use: archive vs live welcome/staff claim; claim vs archive after waiting; archive vs new public submission; two admins on the same registration; same-UUID concurrent replay; archive vs task/slot update; restore vs archive. Verify whole-transaction rollback on busy/conflict, no quota reset or notification duplication, and no changed Auth/People/care rows. PGlite tests alone do not prove multi-connection row-lock behavior.

Primary references reviewed: [Supabase database functions](https://supabase.com/docs/guides/database/functions) and [Supabase changelog](https://supabase.com/changelog). All public API wrappers remain invoker functions; privileged operations are private with empty search paths and current staff authorization. No browser role gains table writes or private lifecycle-table reads.
