# Current seven-migration local rehearsal

This directory prepares a separate, unlinked local office stack and provides a bounded Auth/PostgREST service check. It does not start services, deploy the app, change hosted settings or reproduce the historical restore drill automatically.

The corrected preparer has **13/13 independent pure tests passed**, including refusal of source drift that disables the email provider. The corrected service checker has **18/18 pure guard tests passed**, including the observed Mailpit container port `8025/tcp` published only at `127.0.0.1:55524`, refusal of the earlier project, and a read-only Auth-settings gate before any fixture is created. These total **31 pure checks**. A preparation result of `prepared_not_started` proves the copied inputs and configuration, not a running office.

The first local attempt on September 9, 2026 used project `bcbc-office-current-rehearsal`. Startup and the virgin seven-migration catalog passed, but its first password-token request failed with HTTP 422 and the redacted code `email_provider_disabled`. That configuration disabled both signup flags; in CLI 2.117.0, disabling `auth.email.enable_signup` also disabled the email provider needed for password sign-in. The single created fictional Auth account was contained and banned. That failed attempt's private configuration, report and volumes remain preserved; it is not a successful HTTP rehearsal.

The corrected attempt used a **new v2 project and private directory**, retaining the source email-provider setting while disabling only global public signup. **The actual v2 HTTP rehearsal passed all 10 milestones on September 9, 2026, with all four account cleanups confirmed.** Six services used the new loopback stack and the exact seven migrations. Both new `555xx` stacks are now stopped with two data volumes retained for each; the first failed attempt and all three predecessor inventories remain preserved. No force, reset or in-place repair occurred. See the [sanitized results](results.json).

The final v2 inventory contains four confirmed, banned fictional Auth accounts, zero sessions or staff roles, one retained synthetic contact, and zero Storage objects or app profiles. The fixture's contact/audit history remains retained. These are local service results, not hosted, uploaded-file or phone acceptance.

## Separate project and ports

The fixed project is `bcbc-office-current-rehearsal-v2`.

| Purpose | Local port |
| --- | ---: |
| API | 55521 |
| PostgreSQL | 55522 |
| Shadow database | 55520 |
| Captured mail interface | 55524 |
| Optional browser preview and Auth callbacks | 8830 |

Other configured `553xx` ports are remapped to `555xx`; their disabled services remain disabled. The preparer opens no listener. The separately reviewed startup procedure must verify published API/database/mail bindings at `127.0.0.1` and use the dedicated local Docker socket. Port 8830 is a configured origin, not evidence that a browser preview is running.

The original `bcbc-office-rehearsal` on `553xx` and `bcbc-office-restore-rehearsal` on `554xx`, their preserved volumes, demonstration data and the [historical restore runner/results](../office-restore/README.md) remain untouched. The first `bcbc-office-current-rehearsal` attempt is also preserved separately. Do not rename their migrations, reuse their project names, overwrite their volumes or reset them to run this check. The older signup-enabled HTTP harness and six-migration recovery proof describe their original baseline.

## Offline preparation

Use Python 3.11 or newer, from the repository root:

```sh
python3 -B tools/office-current-rehearsal/prepare.py /absolute/physical/private-parent/new-current-stack --json
```

Choose an existing private parent and a **new absolute destination outside every Git repository**. Every path component must be physical: symlink ancestors, symlink targets and `..` traversal are refused. On macOS, use the physical `/private/tmp` path instead of its `/tmp` alias when appropriate. Existing destinations are never reused. A partial failed preparation remains preserved for inspection; choose a new destination after addressing the fixed diagnostic.

The preparer writes exactly nine files: `supabase/config.toml`, seven SQL files, and `preparation.json`. Every created directory is mode 0700 and every file is mode 0600, regardless of the caller's umask. Files are created exclusively. It refuses a linked source project, unexpected migration inventory, changed source hashes or unsafe/offloaded source files. Source files are read only.

`prepare(destination: Path)` returns a sanitized dictionary. `preparation.json` records the fixed project/ports, seven versions, eight payload paths with byte lengths and SHA-256 values, and the configuration fingerprints. It omits absolute destination paths, credentials and personal records. It does not hash itself. CLI success is exit 0; refusal is exit 2. With `--json`, argument and preparation failures remain parseable fixed JSON without echoing private arguments.

## Pinned inputs and allowed changes

The source configuration is `tools/office-local-stack/config.toml`, pinned to SHA-256:

```text
88ce777af740bdc8dd9d0560a50a429ddedf91467e0b0841b57253f81ca6f580
```

The corrected v2 configuration is 15,823 bytes with SHA-256:

```text
48ec9854933aa781e2d6499cbc8af360f647f00c9e49d5f638cca424dab6c0c8
```

Only the project name, `553xx` → `555xx` ports, `8810` → `8830` origins/callbacks, and the global signup flag change. `auth.enable_signup` is false **in the new local config only**. `auth.email.enable_signup` remains the source value true so the email/password provider remains available. A whole-TOML comparison rejects any additional semantic change. Before creating fixtures, the checker requires actual `/auth/v1/settings` to report `disable_signup: true` and `external.email: true`. Captured mail stays local; no production SMTP, SMS provider or external sign-in provider is enabled.

The seven SQL versions are `20260908220558`, `20260908220613`, `20260908220623`, `20260908220645`, `20260908220658`, `20260908220707` and `20260908220718`. Each filename, SHA-256 and dependency must match both the reviewed [preflight manifest](../office-preflight/manifest.json) and the independent constants in `prepare.py`; updating a manifest digest cannot authorize changed SQL. The source migration directory must contain exactly that SQL inventory.

The seventh migration keeps public profile submissions paused. No optional account-state guard, intake-reopening migration or unrelated SQL is copied or applied. The capability revision remains `20260907174301`; it does not by itself prove submission privileges are revoked.

## Runtime and credential handling

Startup is a separate operator action using the verified Supabase CLI **2.117.0**, the prepared directory, and its own loopback bridge. Set `SUPABASE_HOME` explicitly to this task's `work/tools/supabase/2.117.0/state`; preserve the real `HOME` unchanged. Do not derive the historical runtime paths from this resident checkout's parent directory. The dedicated Docker socket resolves to this task's `work/office-runtime/colima/office/docker.sock`.

Keep CLI status and startup diagnostics private. For the service checker, pass credentials from captured local status directly through an in-memory subprocess pipe. Never put them in command arguments, environment variables, examples, shared reports, screenshots or files. The checker refuses inherited `DOCKER_`, Python/debug injection and proxy overrides; its own subprocess transport selects the exact local socket. Use a clean child environment rather than passing the runtime shell environment through unchanged. `python3 -B` avoids needing a bytecode environment override.

## Bounded service-check contract

`check_service.py` accepts exactly this argument sequence:

```sh
python3 -B tools/office-current-rehearsal/check_service.py --run --stdin
```

This command requires a pipe from the operator's credential bridge; it is not an interactive credential prompt. Its stdin JSON has exactly four fields: `url`, `anonKey`, `serviceKey` and `allowSyntheticWrites`. The URL must equal `http://127.0.0.1:55521`; the two keys must be the captured local legacy JWTs with roles `anon` and `service_role`, respectively; the synthetic-write acknowledgement must be true. No literal credential example is supplied. Hosted URLs, modern-key substitutions, duplicate/extra input fields, arbitrary actor/SQL flags and environment-sourced credentials are refused.

The real-service sequence passed all ten success milestones. It checked the exact new v2 topology, virgin seven-version catalog and live closed-signup/email-provider settings before any fixture was registered; created four confirmed fictional Auth users with actual password sessions; tested staff readiness and anonymous/nonstaff denial; created one synthetic contact; verified editor versioned updates, viewer denial and stale-write protection; rejected self-promotion despite user-editable role metadata; verified public submission denial plus both entrypoints' revoked grants; verified role removal with the same existing session; and rechecked the final paused-intake catalog with zero staff roles. Positive controls distinguished permission denials from a broken API. Direct SQL was restricted to read-only catalog inspection and assigning/revoking roles for exact registered synthetic identities.

The checker expects 17 public RLS tables, 54 relevant policies, the seven exact migration versions, no initial Auth users/staff roles/contacts/Storage objects, and zero app connections. It never starts a stack, changes schema/grants, applies migrations, opens intake or contacts a hosted endpoint. This smoke check uses Auth and PostgREST; **it does not upload or recover a private file**.

Every fixture account uses the generated `.invalid` namespace and remains local. Cleanup rechecks each registered Auth ID/email, revokes only its role, logs out any obtained session, rechecks ownership, and bans that exact user. Synthetic contact/audit records and banned Auth identities are retained. No account or contact deletion, trigger bypass, database reset or volume deletion occurs. Logout and bans do not establish a general guarantee that every previously issued JWT is immediately invalid; role removal is separately tested against the current database guard.

Output contains fixed milestone names, aggregate counts, cleanup outcomes and a small allowlist of safe HTTP codes. It contains no emails, UUIDs, keys, rows or raw response bodies. Success is `passed_local_http_only` with exit 0. Failed/incomplete runs return exit 1; preflight/input refusal returns exit 2. Any unconfirmed cleanup remains a failure. Retained fixtures intentionally make the virgin-stack guard refuse a blind repeat; preserve the evidence and review the next step without resetting this or an older stack.

## Pure checks and acceptance boundaries

The preparer suite does not call Docker, HTTP or hosted services:

```sh
python3 -B -m unittest discover -s tools/office-current-rehearsal -p 'test_prepare.py' -v
```

The service checker's pure guard and result-interpretation suite also performs no service or fixture operations:

```sh
python3 -B -m unittest discover -s tools/office-current-rehearsal -p 'test_service_checks.py' -v
```

Its result is separate from a real service run. Neither kind of pure test establishes startup or HTTP acceptance.

This actual local HTTP pass establishes only the narrowly checked current-baseline service behavior. Hosted staff/Auth/SMTP acceptance, off-device backup and recovery, current-version database-plus-uploaded-file restoration, real operator workflows, native browser prompts and installed-phone checks remain separate evidence. No hosted setting, optional guard, public release or phone-readiness claim follows from this rehearsal.
