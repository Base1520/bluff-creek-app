# Creek Office reliability and recovery · September 9, 2026

The goal is for common mistakes to be prevented, interrupted work to be recoverable, and unresolved work to have a clear owner. This is a prepared software candidate, not a claim of zero failures or an activated church service.

## What the candidate enforces

| Failure case | Guardrail |
| --- | --- |
| A staff password is forgotten, or an invited staff member needs a first password | Separate recovery page checks current staff access before accepting a new password, scrubs the callback, keeps credentials in memory and returns to a cleared staff login. It does not create or restore a removed staff role. Exact hosted callbacks and email delivery must be configured and rehearsed. |
| Incomplete setup or lost core read access | Live staff-role lookup plus a versioned schema declaration and required module list; verified core reads before editing. Persistent status and refresh action; failed reads are not reported as empty successful lists. |
| A cached role has changed | Role/readiness checks on refresh and before mutations; real identity/role loss clears private dialogs and blocks late responses. Same-user transport failures preserve drafts while disabling writes. |
| Two editors save the same record | Server-owned integer versions and conditional updates on core records, care plans/guest records/guidelines and the four office-content tables. A stale draft cannot overwrite the newer version through these interfaces. |
| The server commits but its response is lost | Stable per-draft IDs, exact returned identity checks, and explicit reconciliation before repeating uncertain creates/updates. Staff review and leadership contact RPCs keep their existing version/idempotency checks. |
| Staff change fields during an upload/save | A submitted snapshot and paused fields/close actions keep one reviewed set of values through the request. |
| Photo/file uploads partly complete | Stable path and metadata IDs; check completed stages before resuming. No automatic destructive cleanup after an ambiguous response. |
| Staff remove a calendar event by mistake | Archive and restore, server-owned archive timestamp, and no authenticated client DELETE grant. Archived entries remain discoverable. |
| Someone closes an edited form accidentally | Changed-draft close confirmation and pending/uncertain save guards. People/event/document, member-history/photo, care, personal follow-up and signup-review drafts request a browser warning before reload or navigation while unsaved or unresolved; office-content forms retain their existing warning. Signup and personal-follow-up Close, Escape and opening another record honor a discard decision and recheck access before replacing drafts. Signing out or confirmed access loss intentionally clears private drafts. |

The operator guide is `admin/help.html`, linked from Overview and setup. People status, office-content archive/status controls, and append-only history already preserve earlier records. Document **details** can be edited; this is not file revision history or a collaborative spreadsheet editor. The new protections do not automatically publish content, invite staff, create a live reminder service, or synchronize the historical Google Sheet.

The reload warning is best-effort, not draft recovery. Browsers choose the prompt text and require prior user interaction; mobile termination may skip it entirely. The handlers are removed after save, discard or access clearing, and store no draft/photo data. Focused tests verify cancelable DOM events, not native prompt display or phone recovery. See [MDN beforeunload](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event). Finish and confirm each entry before leaving; keep source originals separately.

## Late responses and interrupted saves

Documents and membership-page reviews keep a count of unresolved client write requests across their UI deadlines. A progress check that sees no record does not allow discarding a draft while a known request can still respond. A late settlement marks the same active draft for another explicit check; it cannot restart its abandoned save sequence or alter a replacement session. Recovery reads that overlap a settlement cannot clear uncertainty using an older observation. Submitted fields and stable record/file IDs stay together during retries. A matching durable saved record remains the completion proof.

These guards track client requests, not database transaction completion. A rejected request and an absent read cannot prove that the server will never commit later. Sign-out/access loss still clears private drafts immediately; browser termination and external server work remain possible. Keep original files and review suspected unfiled objects privately before cleanup. No durable browser storage, automatic cancellation, deletion or cleanup is added.

Announcements, committee contacts, slides and prayer editors bind discard decisions to the original dialog and draft. Opening the next record rechecks the user, role, readiness and current record after confirmation. An outdated confirmation cannot resurrect cleared details or erase a replacement draft.

## Migration and readiness contract

For a fresh isolated setup, use every SQL file in the explicit order in `admin/README.md`. The sixth, `supabase/migrations/20260908220707_office_record_recovery.sql`, supplies readiness and save recovery; the seventh, `supabase/migrations/20260908220718_pause_public_app_intake.sql`, pauses profile submissions. Current filenames match the recorded hosted versions with all seven SQL byte hashes preserved. See [migration preparation](office-migrations.md); compare existing hosted history before any further application rather than replaying this baseline.

The read-only `office_readiness` RPC checks the current staff role on each call and declares schema revision `20260907174301` and supported modules. Its migration checks prerequisites before installing that declaration. It does not perform a full database integrity audit or test every permission, storage path, authentication email, backup, or delivery channel. Core table reads are checked by the interface; module failures remain visible in their own sections. RLS and server constraints remain the authority for writes.

Local tests exercise real PostgreSQL behavior via PGlite and browser logic with fictional fixtures. They do not contact a hosted church database. The latest September 7 staff suite passed 196 tests, including 11 recovery cases. The separate isolated Supabase stack passed 38 actual Auth/REST/Storage checks, eight password-reset browser checks, seven invitation/first-password checks and seven public-signup browser checks through captured local mail. Native layout review separately confirmed fictional event archive/restore, an announcement save, and the editor and guide at 375px. Review the evidence at the release commit and repeat critical cases on the authorized hosted configuration before loading real records; these local passes do not establish hosted delivery, file restoration or operator acceptance.

## Rehearsal before the private pilot

Use fictional records and two designated test staff accounts. Record the date, release revision, operator, expected result, actual result and remaining issue.

1. Try anonymous, nonstaff, viewer, editor and admin access; change/remove a role while its tab has a private draft open. Confirm denial, clearing and blocked late responses. Verify a separate staff owner cannot read another owner’s personal leadership follow-ups.
2. Submit an app profile through actual verified-email delivery, match an existing person, then review a new visitor and welcome task. A retry must preserve the reviewed identity and one welcome plan.
3. Have two editors open the same record. Save one edit, then the stale edit. Confirm the first remains and the second gets a recoverable conflict.
4. Interrupt a create after the server commit and a source upload after each stage. Reconnect and reconcile. Confirm one logical record and its original source rather than a duplicate. Do not simulate this with real member information.
5. Archive a staff event, locate it under Archived, and restore it. Verify the event is preserved and the private staff calendar has not changed iCloud.
6. Complete a visit and an attempted call. Verify only the correct care role’s successful contact resets its recurring date. Exercise an unassigned and overdue plan.
7. Open a permitted file, verify source-image access restrictions and signed-link expiry, sign out, then confirm the private view is gone. Test on the actual phone and office computer.
8. Demonstrate the office guide to the primary and backup operators. They should complete one routine and recover one interrupted save without code or database access.

## Backups and operational ownership

Before real records are entered, assign a primary records owner and backup administrator. Document database backup/export availability, retention, restore permissions and file-storage backup separately. A database backup alone is not evidence uploaded source files are recoverable. Rehearse restoring both into a separate test environment; record the actual recovery time and how much recent work could be lost. Backup schedules and notifications remain unconfigured in this candidate.

The September 8 [isolated local restore](../tools/office-restore/results-2026-09-08.md) passed against persistent fictional records and a linked private file. A restored database with one deliberately omitted payload failed the byte check; restoring only that absent payload recovered the exact original bytes, with matching record/policy/migration fingerprints and 36 foreign keys. Source volume bytes stayed unchanged. The run required diagnosed tool/network/response corrections and preserved its failed states. It does not establish production recovery time, off-device backups, retention or a church operator’s ability to restore records.

Keep original handwritten pages, the reviewed source ledger and approved file masters through the pilot and import reconciliation. An interrupted browser session can lose an unsaved draft or recovery state; sign-out during an upload may leave an unfiled private object. A storage administrator should review suspected unfiled objects against document metadata and active work before any cleanup. Never mass-delete a bucket or clear the ledger as a rollback step.

The office owner should check overdue/unassigned queues weekly, resolve failed operations, and review access when responsibilities change. The release owner should keep the previous deployable artifacts and migration history. Rolling back front-end files does not undo legitimate database writes. External alerts and backup monitoring require a separately configured delivery process and a verified recipient; a dashboard alone cannot ensure someone saw the task.
