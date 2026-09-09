# Current seven-migration local recovery rehearsal

**Actual local recovery passed September 9, 2026:** five source milestones, seven cold-restore milestones and 44 pure tests. The first attempt stopped on an incorrect historical root-mode assumption; a separately reviewed continuation preserved the source's observed `100:101 / 0750` metadata and first-failure evidence. This was not a clean first-attempt timing benchmark. See [the recorded result and limits](results.json).

This separate drill uses the seven active migration files and their fixed hashes. The historical six-migration runner and its preserved evidence remain unchanged. No hosted project, existing demonstration, public intake or optional account guard is changed.

## Fixed sequence

1. `prepare_source.py --prepare --json` creates only the new private source configuration and seven SQL copies. The fixed source is `bcbc-office-recovery-source-v1`, API/database/mail ports `55621`/`55622`/`55624`, and browser origin port `8831`. Global signup is disabled; the email/password provider remains enabled. Seeds, external SMTP, anonymous signup and SMS are disabled.
2. The parent independently reviews and starts that source using the task's dedicated Docker socket and Supabase CLI **2.117.0**, then checks the six pinned image IDs, loopback bindings, empty catalog and preserved predecessor inventories. Neither preparer nor seeder starts services.
3. `seed_source.py --run --stdin` accepts only its exact loopback URL, local anonymous/service JWT keys and `allowSyntheticWrites: true` through stdin JSON. It creates one generated confirmed `.invalid` editor and one fictional contact, original, document and linked membership-history record through local Auth/PostgREST/Storage. It verifies the original and link, requests logout, removes only that locked, verified fixture identity's role/session/refresh rows, and bans the identity. This fixture containment does not prove production logout behavior. It must finish with zero roles, sessions and intake. Keys, passwords, UUIDs and response bodies are never printed.
4. After source containment and a coordinated write pause are verified, `restore.py --run --private-dir <fixed-private-directory>` performs the cold drill. Its only accepted destination is this task's `work/office-current-restore-private-20260909-a`; it creates target `bcbc-office-recovery-target-v1` on `55721`/`55722`/`55724`, browser port `8832`. The exact task `SUPABASE_HOME`, dedicated socket, resident CLI and source configuration hash are required. New target volumes must be absent, then independently proved empty and owned by this run.

The source lives at this task's `work/office-current-recovery-source-private-20260909/stack`. Private directories use `0700`; prepared SQL, configuration, manifests and archives use `0600`. Actual CLI-generated local credentials and physical Auth state stay outside Git and shared outputs.

## Recovery evidence required

The runner verifies the exact synthetic source, seven migration rows, 17 public RLS tables, relevant policies, paused public/private intake grants and document/history links. It stops only the new source, requires clean PostgreSQL shutdown, and captures complete database and Storage volumes through read-only, network-disabled helpers.

The new target first receives the complete database with exactly one original omitted. Database fingerprints must match while the original fails. HTTP `400`/`404` requires a recognized missing-object code; HTTP `500` requires `InternalError` and `ENOENT` for the exact absent payload. Authentication failures, arbitrary server errors and prefix-matching paths do not count.

After target shutdown, only that absent file is restored from the pristine verified archive using overwrite-refusing extraction. Complete prestart file hashes, restored database/catalog/foreign-key fingerprints, authorized original bytes and anonymous denial must pass. The frozen source's full physical manifests must remain unchanged. Both new stacks finish stopped with volumes preserved. The parent separately compares all four predecessor inventories; that comparison is not built into this runner.

## Boundaries and failures

Do not rerun a preparer, seeder or restore into an existing destination or nonvirgin source. There is no reset, volume deletion, automatic resume or historical-runner repointing. Preserve failed states and private evidence; the parent must review any continuation.

Physical restore depends on the exact pinned PostgreSQL **17.6** and companion images. This is a bounded local cold-volume drill, not a logical roles/schema/data export, hosted recovery, encrypted off-device backup, operator acceptance, or production recovery-time guarantee. `tools/office-backup/check_bundle.py` checks a different supplied logical-export/originals contract; its checksum result cannot substitute for this drill.

The observed `0750` mode was preserved, not changed to satisfy the old assumption. [PostgreSQL documents group-readable cluster access](https://www.postgresql.org/docs/17/app-initdb.html). The missing-original phase produced `500 / InternalError` with the exact file path’s `ENOENT`; arbitrary errors remained refused. Database/Storage archives and the initial failed state are retained privately. No capture/export/restore was performed against the hosted church project.
