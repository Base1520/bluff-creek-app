# Offline office wiring preparation

This tool validates a small private JSON input and optionally stages browser configuration for review. It never contacts Supabase, changes source configuration, applies SQL, creates accounts, sends messages or deploys anything. Use the existing church project; this tool does not create or verify one.

The example input deliberately contains rejected placeholders. Prepare a private copy outside the checkout and replace those values locally. Do not paste keys into command arguments, output logs or screenshots. A browser publishable key belongs in the generated browser configurations; secret/service-role keys and legacy JWT keys are rejected.

## Input contract

- `projectRef`: exactly 20 lowercase ASCII letters; no placeholder text.
- `supabaseUrl`: exactly `https://<projectRef>.supabase.co`, with no trailing slash or extra URL parts.
- `publishableKey`: modern `sb_publishable_` prefix followed only by letters, digits, underscores or hyphens. Placeholder and secret/service-role forms are rejected. Its opaque value cannot be matched to a project offline.
- `appOrigin`: a canonical HTTPS origin such as the approved app host, without a trailing slash, credentials, port, path, query or fragment. ASCII dotted DNS names only; no IP address, localhost, reserved test/private suffix, IDN/punycode or known loopback wildcard service. Syntax checks do not establish DNS resolution, ownership or public reachability.
- `publicSignupEnabled`: required JSON boolean. `false` stages **staff browser configuration only**, with blank public connection configuration. `true` separately stages the public signup UI for review. Neither value changes hosted Auth settings or RPC access.
- `membershipSheetUrl`: omit or set to exactly `""`. Nonempty values are rejected. The generated office field is always empty because browser-served configuration must not carry a private membership-ledger link.

Unknown or duplicate keys, arrays/nested values, comments, trailing commas and missing fields are rejected. No input or key values are printed on success or failure.

## Validate or stage

From the app checkout, with a private input path:

```sh
node tools/office-wiring/cli.mjs --input /absolute/private/input.json
node tools/office-wiring/cli.mjs --input /absolute/private/input.json --output /absolute/private/new-packet
```

The first command writes nothing. The second is explicit staging into a **new** directory with an existing parent. Even an empty existing destination is rejected. Input and output paths cannot include `.`/`..`, backslashes or symlink components; on macOS use `/private/tmp` rather than the `/tmp` symlink when appropriate. Directories use mode `0700`; files use `0600`. Files are opened exclusively without following symlinks. Keep parent directories under trusted local control; this is not a defense against a hostile process concurrently replacing ancestors. An incomplete packet remains after a write failure for inspection, and cannot be overwritten by retrying.

The packet contains:

- `admin/config.js`: the existing three literal fields, with membership link blank.
- `js/connection-config.js`: blank settings for staff-only UI staging, or the same reviewed project/key and one exact allowed origin for separate signup UI staging.
- `report.json`: redacted mode/target/callback and unverified-gate report; no API-key values.
- `SETUP-CHECKLIST.md`: exact target and callbacks plus review-only setup prerequisites, with no apply commands or API keys.

Blank public browser configuration does **not** disable backend Auth signup or RPCs. Explicitly choose and review hosted Auth's allow-new-signups setting; do not copy local rehearsal `auth.enable_signup=true`. Confirm project ownership/key association, exact callbacks, staff role assignment, all seven migrations, RLS/storage/advisors, email delivery and recovery/backup procedures before activation. Staging is not release authorization and contains no real member records.

The reviewed seven-migration sequence ends by revoking public profile-submission access from both the public and private save functions. That is a database pause for the staff-first rollout; it does not disable Auth signup, send email, or change staff review of existing submissions. This tool reports that intended default separately from actual hosted state, which remains unverified. A `true` UI setting cannot reopen database intake. Reopening requires a separately reviewed migration and successful hosted signup/email testing.

For a complete static app/office package, use [office-release](../office-release/README.md); the wiring packet alone contains only the two configuration files.

## Verification

```sh
node --test tools/office-wiring/wiring.test.mjs
```

Tests use fictional configuration, temporary private directories and the actual preflight/recovery/connection parsers. They check strict input rejection, staff/public UI separation, runtime compatibility, no overwrite or traversal/symlink writes, file permissions and redacted CLI/report/checklist output. These checks never contact a hosted project or establish production readiness.
