# Local database and private-file restore rehearsal

**Historical revision required:** this runner is intentionally fixed to the six-migration recovery rehearsal. The current staff-first manifest contains seven migrations, so a current-checkout run against the preserved six-migration source will safely refuse. Use the matching reviewed historical revision to inspect/reproduce that result. Do not relax its fingerprint, alter the live demonstration, or reset records to make it pass. Hosted recovery of the seven-file baseline remains a separate acceptance check.

This runner rehearses recovery of the existing **fictional** local office stack into a separate disposable target. It is fixed to this task's Docker socket, Supabase CLI **2.117.0**, six observed immutable service images, PostgreSQL **17.6**, nine banned `.invalid` Auth users, zero staff roles, one history-linked document/object and the six reviewed migrations. It supports no hosted destination or arbitrary SQL. Production configuration and source files are unchanged.

**Actual local recovery passed on September 8, 2026, through reviewed continuations.** See [the dated evidence and limitations](results-2026-09-08.md). This was a real database-plus-file recovery with a deliberately incomplete phase; it was not a clean first-attempt run or a production recovery-time test.

## Before running

- Use Python 3.11 or newer. The parent operator must first review this runner and its exact source/target boundaries.
- Source `../office-runtime/env.sh` in the task shell. The dedicated runtime and source `bcbc-office-rehearsal` must already be healthy at API `127.0.0.1:55321`, PostgreSQL `55322`, and captured mail `55324`.
- Stop using source browser/app/API write flows during the entire baseline-to-shutdown interval. Zero staff roles and banned fixture users limit access; they do not prevent a separate operator from creating another signup. The target's restored logical comparison detects source data that changed after the baseline, but this is not an online atomic database-plus-files backup.
- The target project `bcbc-office-restore-rehearsal`, its volumes and its network must not exist. Ports `55421`, `55422`, and `55424` must be unused. The target uses a new run-labeled bridge whose published ports bind to `127.0.0.1`, matching the working source stack. An internal bridge prevented the local CLI from reaching the published PostgreSQL port during the first drill; offline backup helpers still use `--network none`. The runner never overwrites an existing target, resets a stack or deletes a volume.
- Keep all required config, migration, CLI and source files resident. macOS offloaded files fail with `LOCAL_FILE_OFFLOADED_OR_UNSAFE`; the runner does not repair or hydrate them.
- Allow enough private disk space for the source and target plus verification archives. Each archive is capped at 2 GiB; this exact fixture's observed Docker volumes total approximately 70 MB. Archive extraction currently buffers one archive in process memory, so this is intentionally unsuitable for a large church production database.

From the app repository, first run the pure guards:

```sh
python3 -B -m unittest discover -s tools/office-restore -p 'test_*.py' -v
```

Then use a **new absolute** sibling directory under this task's `work/`, named `office-restore-private-<suffix>`:

```sh
source ../office-runtime/env.sh
python3 -B tools/office-restore/restore.py --run --private-dir /absolute/task/work/office-restore-private-20260908-a
```

Replace the example path with this task's actual `work/` path. It must remain outside the app repository. The runner creates it with mode 0700 and writes private files with mode 0600. Do not put its contents in Git, user-facing outputs, screenshots or shared logs: physical database archives contain password hashes and retained Auth state, even though the fixture identities are fictional.

## What the run proves

1. Exact local service images/mounts/listeners, local volume drivers and labels, source configuration, all 17 public tables, synthetic Auth users/identities, private bucket/object metadata, six migrations, foreign-key relationships, history-photo linkage and authorized source bytes.
2. Source project stop with preserved volumes, no running mounts, and `pg_controldata` confirming a clean shutdown. Offline helpers use the existing database image with no network, a read-only root filesystem, explicit capabilities and read-only/no-copy source mounts.
3. Complete database and Storage archives with safe path/type checks, numeric ownership and per-file content hashes. Extraction revalidates the registered archive hash and manifest, then hashes the actual input bytes again. Both new target volumes must be empty and labeled with this run's identity.
4. A real target starts with the database fully restored and exactly one observed file payload deliberately omitted. Database fingerprints must match, but the authorized Storage download must fail. A file-backend HTTP 500 is accepted only with `InternalError` and an `ENOENT` log entry for the exact omitted payload; arbitrary server/authentication errors fail the drill. The pristine backup and source remain intact.
5. After stopping the target, only the exact absent payload is restored from the verified backup, without overwriting another file. Corrected Storage bytes match before startup; database relationships/policies and private API bytes match afterward. Anonymous public-file requests remain denied. Privileged downloads prove file availability separately from the anonymous access check; no user login or staff-role assignment occurs.
6. Source volume identity and complete physical manifests remain unchanged after capture. Both task stacks end stopped with all volumes preserved. The parent handles the dedicated runtime itself.

Physical database files are compared **before** target startup; running PostgreSQL changes them. Logical fingerprints include all application rows, Auth users/identities, buckets/objects, migration history, policies, relevant grants/functions and validated FK definitions. Only Storage `last_accessed_at` is excluded from row fingerprints because object reads can change it. Other transient Auth tables remain physically backed up but are not asserted unchanged after service startup.

## Results and failure handling

Standard output contains fixed stage names and a sanitized final JSON report. Subprocess diagnostics, SQL rows, keys, API bodies, object keys and callbacks are never printed. Credentials come from captured local CLI status into memory only. The private directory retains `state.json`, baseline/volume manifests, pristine archives and the incomplete/corrected target evidence.

Success is exactly `passed_local_restore_only`, with separate evidence that the missing-file phase failed as expected. Any mismatch yields a non-success exit, the precise stage, a fixed error code and a next-action note. After a target start attempt, the runner attempts only its task-scoped, data-preserving stop; uncertain cleanup is explicitly flagged. A preflight refusal leaves the source running. There is **no automatic resume/reset**: inspect the private stage evidence and preserve failed state before choosing a reviewed recovery step or a new disposable target.

This local drill does not establish encrypted off-device backups, retention/monitoring, hosted key recovery, production restore compatibility, recovery-time commitments or an operator's ability to recover church records. Those remain separate launch gates. [Supabase backup boundaries](https://supabase.com/docs/guides/platform/backups), [PostgreSQL filesystem recovery](https://www.postgresql.org/docs/17/backup-file.html), [Storage metadata versus objects](https://supabase.com/docs/guides/storage/schema/design).

Current verification: **19 pure guard tests passed** on September 8, 2026, including rejection of unrelated or prefix-matching ENOENT paths, arbitrary HTTP 500 responses and authentication failures. Two tiny tmpfs-only BusyBox tar checks verified Docker stdin, root ownership/mode restoration and absent-file correction before the real target was resumed.

The [actual local result](results-2026-09-08.md) records seven passed milestones, exact logical/schema/private-file verification, original source preservation, both stacks stopped and no unconfirmed cleanup. The earlier extraction/start/response-verifier failures and their private evidence were retained. Existing target volumes intentionally make a fresh `--run` refuse; there is no automatic repeat or generic resume command.
