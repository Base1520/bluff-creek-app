# Optional account guard: isolated service acceptance

This folder prepares and checks one new local Supabase stack containing the seven active office migrations plus the optional account eligibility guard. The active `supabase/migrations` directory, its seven-file manifest, hosted project, browser code and release packets remain unchanged. The checker does not apply migrations.

**Evidence status — September 9, 2026:** the actual local Auth/PostgREST/Storage run passed all eight milestones with no failed checks or unconfirmed cleanup. API logout, exact role/session containment and Auth ban were confirmed for all four fixtures. Final counts were four banned fictional Auth users, zero roles/sessions/refresh tokens/intake rows, one contact, one document, one private original and three audit rows. The 32 offline tests also pass: 11 preparation tests and 21 checker tests. The new stack finished stopped with both volumes retained; six earlier projects and all twelve predecessor volumes were verified unchanged. [Frozen results](results.json) record the separate execution and preservation evidence. The in-memory fake service in the checker tests verifies control flow and failure handling; the separate actual run supplies the HTTP evidence.

## Fixed target and preparation

| Item | Reviewed value |
| --- | --- |
| Project | `bcbc-office-account-guard-v1` |
| Network | `bcbc-office-account-guard-v1-loopback` |
| API / database / mail UI | `127.0.0.1:55821` / `55822` / `55824` |
| Shadow database / browser origin | `55820` / `8833` in the prepared config |
| Private stack | Task `work/office-account-guard-service-private-20260909/stack` |
| Config SHA-256 | `1cd09cbbe5787004dca031329c71e8de5242b54c89c586cf904623b5b2521a73` |
| Optional migration | `20260909024020_require_eligible_staff_auth_account.sql` |
| Optional SQL SHA-256 | `7530eb7cd955ec1522943a179aebc03088a3ebc8126a4f4300e08eb5695bdc7b` |

`prepare.py --prepare --json` exclusively creates the fixed private directory and eleven files: config, eight SQL files, unchanged optional manifest and preparation report. It verifies source hashes first, uses directories mode `0700` and files `0600`, and refuses an existing or partial destination. Account signup is disabled globally while the email/password provider remains enabled for explicitly created fictional fixtures. This does not enable public registration or send mail.

The source verifier checks exact bytes, ownership, modes, eight-file migration inventory and absence of a hosted `project-ref`. Ordinary local CLI `.temp` metadata may exist. Preparation starts no services. A separately reviewed private startup driver starts only the new project and records predecessor container/volume inventories; predecessor preservation is independent driver evidence, not a claim made by the checker itself.

The checker verifies the six pinned container image IDs, exact project names/labels, dedicated network, database/Storage volumes and only the intended loopback port bindings before credential requests or SQL. It uses the fixed Docker binary and dedicated task Unix socket, a fresh private Docker config and a constructed environment. It refuses proxy, debug, Python loader and Docker overrides. No old runner globals are repointed.

## Workflow and input

The reviewed sequence is: prepare a brand-new destination, inspect and start its isolated services, verify the virgin eight-migration catalog, run the checker once through the private credential bridge, then review its sanitized result and predecessor inventories. Root controls startup and execution. Do not rerun preparation or the checker against retained fixtures after a completed, failed or interrupted run; preserve evidence and separately review any continuation or new project.

The checker accepts exactly:

```sh
python3 tools/office-account-guard-service/check_service.py --run --stdin
```

Its bounded stdin JSON has only `url`, `anonKey`, `serviceKey` and `allowSyntheticWrites`. The URL must be exactly `http://127.0.0.1:55821`; the acknowledgement must be Boolean `true`. Keys must have the expected distinct local anon/service-role actors. Keys come from the private bridge, stay in memory and must not be placed in argv, source files, Git, reports or shared documents. The API validates signatures; decoding a JWT locally is only an actor sanity check. There are no arbitrary URL, SQL, fixture, reset or environment-key options.

The initial gate requires zero Auth users, identities, sessions, refresh tokens, office rows and Storage objects; exactly eight migration versions; all 17 office tables with RLS; the expected policies/functions/private bucket; paused public intake; and the optional helper's exact body, owner, return type, security attributes and ACL. It refuses the previous seven-migration stacks.

## What the eight milestones establish

1. Exact virgin local stack, preinstalled guard and closed-signup/provider settings.
2. Four confirmed generated `.invalid` accounts with actual password sessions; admin/editor/viewer readiness controls and nonstaff/anonymous denial.
3. Admin contact creation, editor optimistic update and private 68-byte PNG upload with document metadata; staff read controls and viewer/nonstaff protected-write denial.
4. AdminAuth ban followed by protected office read/readiness/write/upload/new-sign denial using the **same existing editor token**. The separately permitted own-role row remains a valid-token control. A signed URL issued before the ban is checked as a still-usable bearer link.
5. Unban followed by readiness, contact/file reads and new signing with that same editor token.
6. Exact fixture role removal followed by protected record and Storage denial with the same token.
7. Public profile submission remains paused; denied attempts leave content, audit records and Storage metadata unchanged.
8. All four registered fixtures are contained, with zero roles, sessions, refresh tokens or intake rows and only the expected fictional contact, document, original and audit records retained.

A permission denial requires an expected permission code and positive controls; JWT, parser, database and transport failures are failures. Upload probes require `AccessDenied`. Known-existing object read/sign checks may accept `NoSuchKey`, with authorized same-object controls. Only the separate public URL privacy check accepts `NoSuchBucket` with HTTP 400/404, because the current catalog and authorized download establish that the private bucket and original exist. That code never counts as permission evidence for protected reads, signing or uploads.

## Cleanup and evidence limits

Every fixture has a fresh UUID and an exact generated `.invalid` email registered in memory. The only SQL mutations assign/revoke a registered role or contain a registered account. Each statement first locks and verifies its exact Auth UUID/email pair. Containment removes only that fixture's staff role, refresh tokens and sessions; no Auth user or fictional record is deleted. API logout is attempted for an observed session. Independent SQL containment still runs when a password response is lost or Admin GET fails, and AdminAuth ban is separately verified against the exact identity. This fixture containment is not a new production logout mechanism.

Reports contain fixed milestone names, statuses, safe error codes and aggregate cleanup counts. They omit keys, tokens, signed URLs, UUIDs, emails, object paths, source rows and raw HTTP responses. Success is `passed_local_guard_http_only`; any failed check or unconfirmed containment yields `failed_or_incomplete` and a nonzero exit. There is no automatic reset, retry or resume. No records are silently removed to manufacture a clean result.

The guard is installed from startup here. Historical before/after reproduction remains the separate PGlite suite: nine test results covering 18 identity states. This real-service matrix does **not** claim an actual HTTP pre-guard reproduction or repeat every simulated identity state. It specifically exercises confirmed staff, ban/unban and role removal through the running services.

The guard does not revoke existing signed URLs, recall downloaded files or globally revoke JWTs. The same-token checks distinguish subsequent protected office requests from those limits. A local pass is not hosted activation, invitation/email delivery, browser/phone acceptance, current-eight recovery acceptance or operator approval. The separately completed seven-migration recovery remains separate evidence. No hosting, DNS, account ownership, recipients, purchases, messages, real records or existing projects are inputs to this rehearsal.

Offline tests can be run without startup:

```sh
python3 -B -m unittest discover -s tools/office-account-guard-service -p 'test_*.py'
```
