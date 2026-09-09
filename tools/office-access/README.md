# Private primary and backup administrator setup

This offline tool prepares a small, reviewed role-grant transaction for exactly two already-created Auth accounts in the dedicated church project. It does not create users, invite anyone, send mail, connect to a database or execute SQL. The two accounts receive only the existing `admin` application role; this does not make them Supabase organization administrators.

The input is private JSON with exactly `projectRef` and `admins`. The target must be the church project's reference `xzfeumdonxeodqhfirjr`. `admins` must contain exactly two objects, each with `email` and `userId`. Privately obtain each intended email and matching Auth UUID through the authorized account setup process. There is no role option or arbitrary SQL input. Do not put real input, generated SQL or account identifiers in source control, static assets, screenshots, messages or command-line arguments.

Email validation accepts ordinary ASCII mailbox addresses, including plus tags; it lowercases case for matching and does not remove plus tags or dots. Quoted/internationalized mailbox forms require separate review. UUIDs must use canonical UUID layout with a valid version/variant. Duplicate emails (ignoring case), duplicate UUIDs, missing/extra fields, malformed values and duplicate JSON keys are refused. Input is limited to 8 KiB. Keep the input in a private directory with mode `0600`.

```sh
node tools/office-access/cli.mjs --input /absolute/private/input.json
node tools/office-access/cli.mjs --input /absolute/private/input.json --output /absolute/private/new-access-packet
```

The default validates format only and writes nothing. Explicit output creates a new private directory (`0700`) and three files (`0600`):

- `staff-admin-setup.sql`: **sensitive**, because the approved email/UUID bindings are required to match the intended accounts. It contains no password or Auth token.
- `SETUP-REVIEW.md`: target confirmation, authorization, role/invitation ordering and acceptance checks. No identity values.
- `report.json`: counts, fixed target, intended role and unverified status. No identity values.

Output must be outside the source checkout, have an existing canonical parent, and not already exist. Symlink components, `.`/`..` components, backslashes and source-nested destinations are refused. Keep ancestors under trusted local control; these checks are not protection against a hostile process replacing path ancestors concurrently. An uncertain partial write remains private for inspection and is never overwritten by retry. CLI success/failure output omits identities and private paths.

The generated transaction briefly takes a SHARE lock on Auth users to prevent a new/changed row creating an ambiguous email match, then locks the role table to serialize grants and the matching Auth rows in UUID order. These locks allow ordinary reads but briefly block Auth user writes and role changes; the transaction is intended for this bounded setup only. It checks the whole pair before any grant: each normalized email must match exactly one Auth account and its supplied UUID; anonymous, deleted, currently banned, and uninvited/unconfirmed accounts are refused. A pending invited account is allowed so its role can exist before first-password setup. A conflicting current role is not silently upgraded. Missing admin roles are inserted; existing admin rows remain unchanged, including timestamps. The result reports only `created`, `already_admin`, and `total_admin_bindings` for the two intended bindings, not all administrators in the database. Any mismatch aborts the entire transaction. Lock and statement timeouts keep this a bounded setup operation.

SQL cannot determine that the operator selected the intended Supabase project. Compare the connected target privately before execution, require the explicit instruction for these exact grants, execute the complete transaction with stop-on-error, and require successful COMMIT before accepting the result. Reconcile uncertain outcomes read-only before retry. Do not run individual later statements after a failed guard. This is operational access setup; it does not belong in tracked schema migrations or the public release packet.

Before sending invitations, separately approve the hosted origin/callback and working SMTP provider. The callback accepts implicit `invite`/`recovery` sessions and requires a live staff role. The normal invite API sends immediately, so invitation and role assignment are not atomic; recipients must wait for role confirmation before completing their setup. Existing accounts, duplicate/inconclusive creation responses and conflicting roles require reconciliation, never blind account recreation or automatic elevation. The default Supabase mail service is not production SMTP. Keep public signup UI blank and the profile-submission grant pause in place during staff setup. Follow [staff recovery guidance](../../admin/README.md#staff-password-reset-and-first-password-setup) and the generated checklist.

## Verify locally

```sh
node --test tools/office-access/*.test.mjs
```

The SQL tests use the exact eight manifest migrations, an in-memory PostgreSQL database and fictional `.invalid` accounts. They do not call a hosted service or validate live email. The filesystem/CLI tests verify parsing, duplicate rejection, private modes, no overwrite, path boundaries and redacted output. No baseline migration or rehearsal helper is changed.
