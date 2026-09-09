# Complete static office and app release packet

This offline builder prepares the **full static app**, including `connection.html`, its styles and scripts, the staff office, recovery page, public resources and licensed local fonts. It creates a new private packet with an uploadable `site/` directory and separate review files. It does not serve the repository or create another demo.

The checked-in `manifest.json` is the explicit file allowlist. Nothing is found recursively. Repository metadata, docs, tests, tools, migrations, private files, the separate brand studio and hosting configuration such as `CNAME` are excluded. A changed allowlist needs review. Hosting/domain settings remain separate from this static package; no source hosting configuration is copied or modified.

## Prepare

Use the private JSON contract from [office wiring](../office-wiring/README.md). This builder delegates hosted config validation/generation to that tool. Existing `admin/config.js` and `js/connection-config.js` are never read, executed, hashed or copied, so a local/demo configuration cannot accidentally be released. Their generated replacements contain only the reviewed hosted project settings, with the membership sheet field blank.

```sh
node tools/office-release/cli.mjs --input /absolute/private/input.json
node tools/office-release/cli.mjs --input /absolute/private/input.json --output /absolute/private/new-release-packet
```

The first command validates the entire package without writing files. `--root /absolute/local/checkout` optionally selects a different reviewed source checkout. The second explicitly stages it into a new directory with an existing parent, outside the source checkout. Directories use `0700`, files `0600`. Existing destinations, output under the source root, symlink components, `.`/`..` path components and backslashes are refused. Use canonical paths such as `/private/tmp` on macOS. Keep parent directories under trusted local control; the checks do not protect against a hostile process replacing ancestors concurrently. An uncertain partial write leaves the private directory for inspection; it is never overwritten by a retry.

## Inspect

- `site/` contains only allowlisted static files. All copied files remain byte-identical to the source; only the two generated configs differ. The public service worker is copied unchanged.
- `review-manifest.json` sits **outside** `site/` and records per-file byte counts/hashes, the allowlist hash, copied/generated provenance, target mode, callbacks and unverified backend gates. It contains no API-key values.
- `SETUP-CHECKLIST.md` comes from the wiring preparation tool and retains the actual hosted setup/approval gates.
- `RELEASE-REVIEW.md` explains the upload boundary. Only `site/` is uploadable. Never upload the enclosing packet or the repository.

The builder checks literal HTML/CSS links, manifest icons/start page, current JavaScript resource-path literals and the public service-worker shell list. Missing connection/recovery assets, unlisted local links, prefills in email/password inputs, direct inline `getElementById("email"/"password").value` assignments, known rehearsal-account markers, inline auth-config overrides and literal local-development config are rejected. Connection and admin routes cannot enter the checked public shell list. These narrow checks cover known fixture-injection mechanisms; they do not certify that arbitrary source contains no PII or secrets. This is static closure verification, not a general JavaScript analyzer or a substitute for code review; dynamically constructed URLs, third-party availability, backend policies, actual email and physical phones still need their own rehearsal.

Literal Google spreadsheet links in static `admin/` HTML, scripts and styles are also refused before staging, including links written with HTML entities. Office source-sheet links belong in an authorized private workflow, not publicly downloadable staff assets. This narrow guard does not classify public calendar sources outside `admin/`, detect dynamically assembled URLs or certify arbitrary source is private-data-free.

Run the separate local office preflight against the reviewed checkout and attach its result to release review. The packet reports that as a separate required check; it does not mislabel static packaging as schema validation. No network, SQL, account, invitation, purchase, email or deployment action runs here. Public signup UI staging and hosted signup/intake posture remain distinct; follow the wiring checklist. Packaging never supplies release authorization.

## Verify the builder

```sh
node --test tools/office-release/release.test.mjs
```

Tests use fictional hosted settings and private temporary source snapshots. They cover exact copies/hashes, static closure, missing connection/CSS/recovery files, generated configs replacing injected demo settings, excluded private/repository files, forbidden public caching, symlink/traversal/no-overwrite behavior, private modes and redacted CLI output.
