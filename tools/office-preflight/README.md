# Local office setup preflight

This checks that the checked-out office files form the reviewed setup packet. A passing result means the **local packet agrees**. It does not mean Creek Office is activated, a project exists, or real authentication, storage, permissions, email delivery or backups have been tested.

From the repository root, using Node.js 20 or later:

```sh
node tools/office-preflight/cli.mjs
node tools/office-preflight/cli.mjs --json
node --test tools/office-preflight/preflight.test.mjs
```

`--root LOCAL_CHECKOUT` checks another local checkout. There are no key, service URL, account or apply options. Exit codes are `0` for a passing local packet, `1` for a failed check, and `2` for invalid command options.

## What it checks

- The fixed SQL order in `manifest.json`, each predecessor, all direct migration filenames, and the SHA-256 digest of each SQL file's bytes. Missing, changed or unlisted migrations fail.
- Required office scripts, styles, help, branding and font files are present and readable within the checkout.
- The client and final migration declare the expected `office_readiness` revision, module names, function form and table prerequisite guard. These are static declaration checks; no SQL is executed and no live role is requested.
- The office configuration uses the expected three string-literal fields. It classifies empty/nonempty fields without evaluating JavaScript, extracting/decoding their contents, or including them in any result. Config files must still be read locally for this syntax/presence inspection. It does not inspect environment variables or credential stores.

It rejects file paths or symlinks escaping the checkout. It makes no network requests, invokes no account or database command, writes no application files, and never applies, concatenates or rewrites SQL. External assets are reported as untested.

## Configuration states

| State | Meaning | Local result |
| --- | --- | --- |
| `not_configured` | Project URL and publishable-key literals are both empty. | Can pass as a prepared candidate; activation remains outstanding. |
| `supplied_unverified` | Both literals contain characters. | Can pass as a prepared candidate; values and hosted behavior remain unverified. |
| `partial` | Only one of those two literals contains characters. | Fails; finish or clear configuration privately. |
| `unassessed` | Unsupported syntax, missing file, or unreadable configuration. | Fails; review configuration privately. |

A nonempty membership-sheet link is reported only as a boolean; it does not affect whether an office project is connected. Nonempty strings are not validated as URLs or keys, so even whitespace or an incorrect value can be `supplied_unverified`. The result never labels those values safe, valid, owned by the church, or activated. Do not paste credentials into the command line or preflight report. Secret/service-role keys do not belong in browser configuration.

## Reviewed SQL order

The current setup packet declares revision `20260907174301` and this explicit order:

1. `supabase/schema.sql`
2. `supabase/migrations/20260907_membership_care.sql`
3. `supabase/migrations/20260907_office_content.sql`
4. `supabase/migrations/20260907164733_app_connections_care_roles.sql`
5. `supabase/migrations/20260907171014_leader_followups.sql`
6. `supabase/migrations/20260907174301_office_record_recovery.sql`

The two legacy eight-digit migration versions collide. Filename sorting and automatic Supabase CLI migration ordering are not a safe substitute for this sequence. This tool does not repair migration history. Follow `admin/README.md` and the activation checklist when an authorized operator is ready to provision the project; reconcile already-applied schema/history before running anything on an existing project.

After an intentional SQL change, review its dependencies and corresponding tests first. Then update the affected digest and, if needed, the manifest's order, expected revision, tables, modules and file inventory in the same reviewed change. There is no automatic digest-refresh command: refreshing hashes without reviewing SQL would hide a mismatch. The manifest is a review record, not a signature or a security attestation. A future migration outside this packet should fail until explicitly incorporated.

## Remaining activation gates

Keep live activation items open after a local pass: approve the church-owned project and hosting, apply the reviewed setup in order, configure browser-safe settings and approved auth redirects, assign named staff roles, verify viewer/editor/admin and revoked/nonstaff behavior in the real service, test private uploads and signed links, test signup review and separate personal follow-up visibility, test backup/restore, train staff, and run a private pilot. The local preflight does not authorize or perform any of those actions. It also does not test calendar synchronization, spreadsheet synchronization, One Call or other outbound delivery.

The regression suite uses synthetic temporary files and the current sanitized source packet. It checks blank/supplied configuration states, output redaction, unsupported executable syntax, digests, ordering, migration inventory, dependencies, readiness declarations, traversal/symlink rejection and CLI exit behavior. It does not connect to a real backend.
