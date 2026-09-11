# Private Guest Register mirror — prepared, not activated

This package copies a minimal, complete Guest Register snapshot into a **new private Google spreadsheet**. Creek Office remains the place to correct, review, or remove guests. Nothing reads spreadsheet edits back into Office. No migration, Edge deployment, trigger, secret, invitation, or Google permission change is executed by these source files.

## Data and access

The service-only `get_guest_sheet_snapshot()` RPC returns exactly `{version:1,generated_at,total,headers,rows}`. The 18 string columns are: Signup date; First name; Last name; Email; Phone; Preferred contact; Permission to contact; Membership (self-reported); Visit status; First visit; Confirmed visit; Next follow-up; Follow-up status; Assigned staff; Welcome email; Review status; Record ID; Updated at.

Rows with `status='archived'` or a nonnull optional `guest_removed_at` are excluded. Restored rows return on the next successful full refresh. Guest follow-up task due/status/owner takes precedence over the older profile follow-up fields, including completed tasks. Optional deacon slots display their current slot/name. Other eligible assignees use the existing approved staff label (email); unavailable assignees are labeled unavailable. An unassigned task shows Office queue. Dates use Central for Signup date, ISO dates for visit/follow-up and UTC for Updated at. Updated at describes the profile record, not the last change to every related task. `Provider accepted` is not a delivery confirmation.

There are no prayer records/text, birthdays, children, addresses, notes, Auth IDs or membership ledger details in the projection. It fails at 5,001 rows; no partial snapshot is returned. The SQL changes only a new private settings table and six new functions. Existing helpers, roles, policies, records, outboxes and active migration manifest remain untouched.

`get_guest_sheet_settings()` is available to eligible admin/editor staff and returns `{version:1,settings_version,sheet_url}` (initially `1,1,null`). `set_guest_sheet_settings(p_version,p_sheet_url)` is admin-only and uses optimistic versions; stale changes raise `40001/GUEST_SHEET_VERSION_CONFLICT`. Only a canonical `https://docs.google.com/spreadsheets/d/<id>/edit` URL or null is accepted. This URL is just the Office button destination; it conveys no Google permissions and never selects an Edge request destination.

The `guest-sheet-snapshot` Edge handler accepts POST `{}` only, with a 32-byte random secret encoded as **64 lowercase hex characters** in `X-Creek-Guest-Sheet-Key`. It rejects browser Origin headers and query strings, provides no CORS permission, returns no-store responses, refuses redirects, and makes only the fixed read-only RPC request. The secret authorizes this guest projection, never other Office operations. A leaked secret exposes the projected fields until rotated; share the spreadsheet/script only with approved staff. Supabase's service-role key stays inside the Edge environment, never in Google, HTML, a browser config or this repository. No raw requests, responses, rows or credentials are logged.

## Exact Google workbook contract

Use the new workbook only. Tab `Guest Register`; exact headers A8:R8; data begins A9; native table name `BCBCGuestRegister` when present. Preserve top-eight/first-three freeze, title A2 and Office-edit instruction A4. The script owns mirror data A9:R, status B5, last successful source timestamp E5 and explanation A6.

The bound script checks its configured spreadsheet ID against the active bound workbook and verifies the exact headers before reading the service. It holds both script and document locks through fetch and write. A complete snapshot is validated for schema, types, dates, unique record IDs, exact count and freshness before any data mutation. One atomic Sheets `batchUpdate` replaces data, clears obsolete cells, expands a native table or converted basic filter, and records success. Only `userEnteredValue.stringValue` is used, so `=`, `+`, `-`, `@`, leading zeros and phone prefixes stay literal; existing formatting is retained, and formatting from the first data row is copied only to new rows. Active filter criteria are preserved. A zero-row snapshot clears old rows but retains one formatted blank table row.

On a read/validation/write failure, the script changes only B5/A6 and keeps E5 unchanged. A transport error can occur after Google's atomic update succeeded: the label says refresh could not be confirmed rather than claiming a failed write could never have committed. The next successful full snapshot safely reconciles this. Missing permissions or a stopped trigger may prevent even a failure label; **E5 is the visible freshness check**. A five-minute trigger is a scheduling interval, not a delivery or uptime guarantee. Human edits made concurrently are outside Apps Script locks; treat mirrored cells as read-only.

## Activation review (owner/root only)

1. Approve the exact proposed migration bytes, new scoped Edge deployment, dedicated secret, private workbook binding, Google authorization and five-minute trigger. Apply after the ten recorded baseline migrations. Optional deacon and guest-lifecycle additions are supported but not required for initial setup; no historical removal/backfill happens here.
2. Deploy only `guest-sheet-snapshot` with platform JWT verification **disabled for this handler**; its own exact shared-secret check is mandatory. Set `CREEK_GUEST_SHEET_SECRET` in Edge secrets. Standard `SUPABASE_URL` must match the church project and `SUPABASE_SERVICE_ROLE_KEY` must exist only in Edge. Do not put a Supabase API key in Google.
3. Convert the **new** reviewed XLSX to Google Sheets while keeping access private. Inspect its actual imported table/filter and frozen layout. Bind `apps-script/Code.gs` and `appsscript.json`; enable the advanced Sheets v4 service. Set Script Properties `CREEK_GUEST_SHEET_SPREADSHEET_ID` and the same `CREEK_GUEST_SHEET_SECRET` privately. Script editors can access script properties; this is not a way to hide the key from spreadsheet editors.
4. The owner authorizes the bound script. The manifest requests spreadsheet access needed by the advanced Sheets batch API, external-request access and trigger management; the fixed workbook-ID check constrains this implementation to the new workbook. It does not request Gmail, mail sending or Drive-sharing access. No public Apps Script web deployment is needed.
5. Run one owner-authorized `syncGuestRegister` and verify the expected real row count and exact data in the private sheet without logging/exporting rows. Confirm no extra fields, correct metadata/header/freeze and literal text. Verify unauthorized Edge calls fail. Any synthetic hosted record needs separate explicit approval; offline tests below do not insert one.
6. Run `installGuestSheetFiveMinuteTrigger` once, from the intended church owner. It reuses an existing matching trigger rather than creating duplicates. Google triggers run as their creator; ownership handoff requires explicit trigger recreation by the replacement owner. Confirm a later automatic refresh and test the documented failure/removal cases in an isolated fixture sheet before claiming automatic acceptance. Set the canonical private sheet URL through the admin-only settings RPC only after verifying the new destination.

Do not put this integration in the public static release packet. Never add a service key to Script Properties. Rotating the dedicated projection secret in Edge and Script Properties is the bounded revocation path; coordinate both sides and check the next refresh.

## Verification

Run from repository root with the existing locked Node/PGlite dependencies:

```sh
node --test tools/guest-sheet/guest-sheet.test.mjs tools/guest-sheet/transport.test.mjs
```

Current local evidence: 11 SQL tests and 16 Edge/Apps Script fixture tests pass (27 total). SQL tests apply all eight frozen baseline application migrations plus recorded direct intake; the tenth pg_cron/pg_net infrastructure migration is hash-verified, not emulated. They also apply the actual optional deacon migration in its compatibility scenario. A synthetic optional removed-at column checks lifecycle compatibility; lifecycle RPC behavior belongs to its separate package. Tests verify baseline function/policy preservation, service/staff ACLs, optimistic settings, 5,000/5,001 bounds, excluded fields and current task ownership; fake network/Sheets tests verify exact credentials/destinations, complete snapshots, fixed failure bodies, atomic changes, obsolete-row clearing, locks and literal values. These are not actual Google, hosted Auth/Edge or trigger acceptance. No live requests or emails ran in these tests.

## Current primary documentation checked 2026-09-11

- [Supabase changelog](https://supabase.com/changelog.md): fetched successfully; no relevant new breaking change for this fixed hosted Edge/RPC addition. No Management logs, self-hosted gateway, extension pinning or Realtime schema change is used.
- [Supabase Edge authentication](https://supabase.com/docs/guides/functions/auth): disabling platform JWT checks requires the handler to authenticate its own external caller; this custom secret is separate from a project-wide Supabase API key.
- [Google atomic batch updates](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate) and [table/update-cell request schemas](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request).
- [LockService](https://developers.google.com/apps-script/reference/lock/lock-service), [script properties](https://developers.google.com/apps-script/reference/properties/properties-service), and [installable triggers](https://developers.google.com/apps-script/guides/triggers/installable).
