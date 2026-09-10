# Five-deacon guest rotation

Prepared for review. This package is separate from the ten migrations already applied to the live Office. Do not replay the older intake migration or merge development source into the static Pages branch.

Every first guest registration receives Deacon 1, 2, 3, 4, or 5 in order. The next slot wraps from 5 to 1. Registration, assignment, due date, welcome job and staff notice jobs commit together. Retrying the same submission, updating an existing profile or rolling back a failed submission does not consume another turn. Private prayers retain their separate routing.

## Ownership and notification

A deacon slot is a stable assignment, not a staff account. The five slots start unnamed and without notification recipients. The private Intake actions screen lets an administrator add a name and select an already approved, eligible Office recipient later. Merely typing a name does not grant access. This change creates no Auth accounts or staff roles.

Until a slot has an eligible recipient, new actions keep that deacon slot while generic notices go to the eligible Office administrators. The UI labels this Office fallback and the missing deacon notification setup. A delivered Office alert is not a delivered deacon alert. Notifications are email through the existing scheduled worker; SMS, phone calls and mobile push are outside this change.

Changing a slot's recipient updates its open actions and enqueues a missing notice for that recipient. Completed actions keep their recorded recipient. A name-only edit sends nothing. Existing jobs keep their immutable payload and task/email deduplication; previously sent or in-flight email cannot be recalled. A former target's attention job is never silently retried when selected again. The existing delivery state remains visible for review.

Admin/editor staff can make an explicit exception on an individual action, choosing a different deacon or manual Office/staff ownership. This does not consume the next rotation slot. Due dates and completion status use the existing optimistic version checks. Roster changes are admin-only.

The fixed roster and cursor live in private tables with RLS and no direct client privileges. Narrow RPCs enforce eligibility and role checks. Shared row locks serialize the next slot with roster edits and manual assignment. When a delivery worker already holds an affected action, roster propagation fails atomically with a refresh/retry message instead of applying a partial roster update or waiting in a lock cycle.

## Compatibility and activation

The new Office code recognizes the older settings contract when rotation is absent. The migration adds the roster/rotation settings without changing its version-1 envelope. No historical task is backfilled, source guest profile or membership record is changed, and no new welcome email is queued for an existing registration. The live precheck on September 10 found zero registrations or intake actions; repeat that check immediately before activation.

The current mail worker, templates, quota and one-minute retry schedule do not need redeployment. Generic messages contain no guest names, contact details, prayer text, addresses or family details. Provider acceptance remains distinct from inbox delivery or completed human contact. Names and recipient bindings belong in the private Office, not the repository or shared launch notes.

Activate the reviewed SQL once, record its actual server migration timestamp and exact source hash, and align the active migration manifest. Publish only the reviewed static Office delta on the release branch, preserving live public app configuration, CNAME and the existing QR destination. Then use a real voluntary signup to verify its owner and notifications; local synthetic tests are not evidence of actual email delivery.
