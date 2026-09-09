# Office backup pair check

This read-only tool checks an **already captured local database-and-originals bundle**. It verifies declared file sizes and SHA-256 hashes, exact file inventory, and the links between supplied Storage object metadata, documents, and membership source references. It does not export, download, execute SQL, restore, contact Supabase, or change any input file.

A passing result is `local_bundle_integrity_verified`. The report always keeps `database_restore_verified` and `off_device_verified` false. This is one preparation step toward backup acceptance; it does not close the hosted backup/restore launch gate.

## What already exists

`tools/office-restore/` contains a successful historical **local six-migration** cold-volume recovery rehearsal. It copied a stopped PostgreSQL data volume and original Storage payloads, restored them into a separate local target, compared database state, and proved an authorized original download. Its deliberately missing-original phase demonstrated why database metadata alone is insufficient. That runner is pinned to its historical migration inventory, volumes, ports, and synthetic fixtures. Do not repoint it at the seven-migration hosted baseline or the preserved demos.

The separate [current seven-migration recovery](../office-current-restore/README.md) also passed a fictional cold database-plus-originals drill on September 9, including a deliberate missing-file failure and a reviewed continuation after a root-permission assumption was corrected. Its source bytes and all earlier project inventories were preserved. Neither local drill is a hosted logical export or off-device backup acceptance.

`tools/office-local-stack/` prepares a new unlinked local seven-migration workspace. It does not export hosted data or copy originals. Office spreadsheet exports and individual document downloads do not capture database schema, roles, privileges, Auth state, and all original files.

No hosted export, original-file capture, or hosted restore has been performed by this tool. There is currently no general hosted backup engine in this repository.

## Private inputs

Keep the bundle and manifest outside this repository and outside public or shared deliverables. Use a church-controlled private location; directory mode must be `0700` and regular file mode `0600`, owned by the current user. The checker refuses symbolic links in input paths, hard-linked files, evicted files, traversal, unlisted files, and unexpected directories. It makes no repairs and never changes permissions. Do not put real manifests, hashes, database dumps, object names, or source pages in Git.

Pass absolute resident paths. On macOS, use `/private/tmp/...` for synthetic scratch fixtures because `/tmp` is a symbolic link. Run against a completed, stable copy with no concurrent writers; this is not a filesystem sandbox against a malicious process that can replace parent directories while the checker runs.

```sh
python3 -B tools/office-backup/check_bundle.py \
  --bundle /private/path/to/office-backup-copy \
  --manifest /private/path/to/office-backup-copy/manifest.json
```

The JSON manifest has exactly these top-level fields:

| Field | Required contents |
| --- | --- |
| `format_version` | Integer `1`. |
| `baseline_manifest_sha256` | Lowercase SHA-256 of the current `tools/office-preflight/manifest.json`. This associates the capture with declared source metadata; it does not prove the hosted migration history or dump contents match it. |
| `database` | One entry each for `roles`, `schema`, and `data`; optionally one each for `migration_history` and `managed_schema_changes`. Every entry has only `kind`, `path`, `bytes`, and `sha256`. Paths begin `database/`; byte counts are positive integers and hashes are lowercase SHA-256. |
| `objects` | Exhaustive supplied inventory of the private `church-documents` bucket, including unfiled objects. Each entry has only `name` and `size_bytes`. Object names are unique and treated as opaque values, never local filesystem paths. |
| `originals` | One local copy for every object. Each entry has only `name`, `path`, `bytes`, and `sha256`. Paths begin `originals/`; names and byte counts must exactly match `objects`. |
| `documents` | Supplied document records, each with only `id`, `storage_path`, and `size_bytes`. IDs are canonical lowercase UUIDs. Each unique storage path must identify a supplied object of the same positive size. |
| `membership_sources` | Every non-null source-document UUID referenced by membership history. Each must occur in `documents`; repeated references are allowed and counted. |

All local payload paths must be unique. The manifest may be inside the bundle, but cannot also be a payload. The bundle must contain precisely its declared files. Every containing directory must be private. Empty `objects`, `originals`, `documents`, and `membership_sources` arrays are valid when the actual source is empty; this does **not** demonstrate recovery of an original document.

The checker permits at most 1,000 entries in each list, a 4 MiB manifest, a 50 MiB original (the current bucket limit), and 2 GiB total payloads. These are bounded pilot limits, not a long-term archive capacity promise. A larger capture needs a separately reviewed adjustment.

Exit `0` returns only counts and the limited integrity result. Exit `1` returns JSON with a fixed refusal code; invalid command arguments return the same sanitized shape with exit `2`. Neither includes private paths, object names, UUIDs, contents, or digests. No credentials belong in the manifest or command line.

## What a pass cannot establish

The inventory is supplied by the capture operator. The checker cannot prove that omitted hosted rows or objects were included, that a file is a valid SQL dump, that roles/schema/data were captured consistently, or that a supplemental migration-history or managed-schema export was unnecessary. A file containing only SQL comments can pass the byte check. Exact source inventory and capture consistency require evidence from the actual export process.

Run `node tools/office-preflight/cli.mjs` separately against the reviewed checkout to verify all seven active SQL files and their recorded digests. Comparing the baseline manifest hash alone does not read or validate those migration bytes. The source preflight also remains a local check; compare the actual hosted history and grants separately during the authorized capture.

The three required database artifacts reflect the documented roles/schema/data separation. The optional supplement slots do not mean those concerns are optional at restore time: the capture and restore procedure must account for migration history and custom Auth/Storage policies or changes. The office has custom Storage policies. Do not blindly replay managed schemas or assume default restore privileges preserve the office's intended access restrictions.

Hashes prove consistency with the supplied manifest, not its authenticity. Private manifests and hashes belong beside private capture evidence; an authorized operator must protect the bundle and establish its source. A local pass is neither encryption evidence nor proof of an independently retrievable off-device copy.

## Smallest remaining hosted pilot acceptance

1. After staff access is accepted, use an explicitly authorized synthetic record and one non-sensitive original page linked to its membership history. No real membership import is needed for this pilot. Even an otherwise empty hosted database may contain real staff Auth identities and password hashes, so any captured dump remains private.
2. Use approved export access and a documented coordinated write pause to capture roles, schema, data, migration history, and the relevant custom managed-schema changes. Separately inventory and copy **every** private bucket object, including objects not yet filed as documents. Reconcile source counts and links during the capture window and build the private manifest. No credential extraction or database-password reset is part of this preparation.
3. Run this checker on the capture. On a separate disposable copy, omit or alter one original and confirm refusal. Preserve the pristine capture. The repository tests exercise this failure behavior synthetically without a hosted account.
4. Use a reviewed restore procedure and a separate, compatible, isolated local target. Restore database state **and original bytes**. Compare the 17 office tables, source-document foreign keys, Auth/staff-role state, recorded migration history, readiness, RLS, function grants, and private Storage rules. Isolate outbound delivery before starting restored Auth services. A file-integrity pass cannot replace this database-and-application recovery test.
5. Prove an authorized original download is byte-identical and anonymous access remains denied. Record recovery time and the capture's data-loss window. Have primary and backup operators rehearse retrieval from the church-controlled encrypted off-device destination, with an assigned retention owner and documented key recovery. That independent copy and operator acceptance remain outstanding until actually demonstrated.

The immediate prerequisites are an approved capture method/access, a reviewed isolated restore target/procedure, and church ownership of the encrypted backup destination, retention, and recovery keys. This tool requires none of those credentials and creates no accounts, records, invitations, purchases, or hosted changes.

## Local verification

```sh
python3 -B -m unittest discover -s tools/office-backup -p 'test_*.py' -v
```

Tests create only temporary synthetic bundles. They cover missing/corrupt copies, broken document/source links, strict metadata, private file modes, unsafe paths, exhaustive inventory, redacted CLI results, and no input mutation.

## Source constraints checked

- [Supabase database backups](https://supabase.com/docs/guides/platform/backups): database backups include Storage metadata, not the stored original objects; off-site copies remain a separate concern.
- [Supabase CLI `db dump`](https://supabase.com/docs/reference/cli/supabase-db-dump): default schema dumps exclude managed schemas; data and custom roles require their respective options. Restored default privileges require review.
- [Supabase backup and restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore): roles, schema, and data are separate artifacts; migration history and custom managed-schema changes need additional handling.

CLI `2.117.0` local `db dump --help` was inspected during preparation. No dump or live database call was executed for this checker.
