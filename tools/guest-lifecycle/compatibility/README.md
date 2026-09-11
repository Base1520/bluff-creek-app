# Future projection compatibility — prepared, not applied

This separate migration closes the removed-guest visibility gap when the proposed **Needs attention** and **communication preferences** packages are activated. It is not applicable to the current ten-file hosted baseline by itself.

Apply only after all three reviewed prerequisites in this package's manifest exist:

1. Guest registration lifecycle (removal/restore markers and RPC).
2. The original Office attention migration.
3. The original communication-preferences migration.

The original future projection migrations and this compatibility change must be part of the same explicitly reviewed activation window, so an intermediate public Office UI does not show removed records. Existing approvals for earlier package bytes do not automatically approve this new compatibility file or the combined activation. No original migration, active manifest, hosted setting or record is changed by preparing these files.

## Exact changes

`private.get_office_attention()` excludes marked tasks, tasks linked to removed/archived registrations, and welcome links whose registration is removed/archived. Active prayers and truly completed care retain the existing notification-attention behavior. All original reason calculations, Central dates, privacy projections, ordering and 5,000-item bound remain unchanged.

`private.get_office_communication_audience()` excludes removed/archived registrations **before** the 5,001 sentinel count and duplicate-email classification. A removed duplicate cannot disqualify the remaining active address. Account eligibility and current-email/preference comparisons are unchanged.

Restore returns the existing registration/action to these projections when it otherwise qualifies. A restored cancelled welcome can appear as an attention item; that does not restart delivery. The compatibility functions only read data. They neither change consent nor rewrite outboxes, receipts, task completion or assignment.

Only two private function definitions are replaced. Existing public wrappers, grants, ownership, security-definer settings, empty search paths, and RLS policies remain unchanged. The migration explicitly refuses absent prerequisites (`55000/GUEST_PROJECTION_PREREQUISITES_REQUIRED`) and unexpected original function-body changes (`55000/GUEST_PROJECTION_SOURCE_CHANGED`). Exact original or already-compatible bodies are accepted; reapplying the exact compatibility migration is idempotent.

## Verification

Run `node --test tools/guest-lifecycle/compatibility/compatibility.test.mjs`.

Fictional PGlite tests verify prerequisite failure, body-drift refusal, unchanged ACLs/policies/data, removed and restored projections, duplicate-email behavior, legacy archived records, active/completed prayer and guest behavior, and permission denials. The fixture verifies all ten baseline SQL hashes and the three exact prerequisite hashes. It executes the nine functional baseline migrations; the native `pg_cron`/`pg_net` extension-only tenth is hash-checked because those extensions do not run in PGlite.

No hosted query, external message, account change, or provider call is part of this package's preparation or tests. It does not change the separately pending guest-lifecycle concurrency acceptance requirement.
