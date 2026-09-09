# Membership preflight

This offline tool checks a local CSV against the observed 16-column A:P membership layout and reports counts and source-row exceptions. It cannot import, connect to Google/Supabase, send messages, perform OCR or change the source. Python 3.10+ and its standard library are sufficient.

The current original ledger remains the working source. This tool does not establish the total number of unique people, explain Column 6, create person IDs, classify historical people as active/inactive, or replace the source walkthrough and reviewed identity crosswalk.

## Run

Only use an explicitly selected export stored in an approved private location, outside source control. Do not publish a Sheet as CSV to make it accessible. This implementation was developed with fictional inputs only.

```sh
python3 tools/membership-import/preflight.py /approved/private/export.csv
```

Without `--output-dir`, it writes no files. Output contains only counts, known issue labels, column letters and source row numbers; names, notes, cell values and the input filename are excluded from diagnostics.

For optional **sanitized** review files, explicitly choose a new directory outside every Git repository:

```sh
python3 tools/membership-import/preflight.py /approved/private/export.csv --output-dir /approved/private/review-run-01
```

This creates `membership-preflight.json` and `membership-review.csv` with restrictive file permissions. Existing files are never overwritten, and output under a Git directory or a symlink into one is refused. Neither file contains raw source values or replaces the source archive. Even sanitized row references should remain with the private migration work. If report creation fails, inspect the chosen folder before using a fresh output folder; one report may have completed.

Exit status `0` means the observed CSV structure was valid and assessment completed. It **never** means approved or ready to import. Status `2` means invalid arguments/input or source structure needing review; `3` means optional report output failed/refused. Unknown identities, statuses and field meanings remain explicit even when structure is valid. There is no `--apply` or raw-data export option.

## What it preserves and checks

- Source bytes and parsed text values remain unchanged in memory. The original file is opened for reading only; no raw input copy is written. Leading zeros, spelling, uncertain dates, blank surnames, unknown values, Unicode, quoted commas and multiline notes are retained.
- The header must have the observed A:P order and names documented in `docs/membership-source-reconciliation.md`. Only header whitespace is normalized for comparison. Missing, changed, duplicate or extra headers prevent field mapping; unexpected header text is not echoed.
- Every data record is counted, including blank and unnamed rows. Wrong-width records are flagged, not silently dropped. Source row numbers count CSV records with the header as row 1; a newline inside a quoted cell is not a separate spreadsheet row. Row numbers are temporary source locators, never member IDs.
- Missing membership/increase numbers and repeated exact trimmed increase numbers, membership numbers and names produce review flags only. Homonyms are never merged, and variants are not guessed. Duplicate checks concern named rows in the validated layout only.
- G remains `Column 6`, with its meaning explicitly unknown. All A:P fields remain in the source, including A/F/G/L/M/P, whose preservation destinations or visibility need review. Every named row's identity is unreviewed and membership status unknown. Dates are never parsed or filled in.
- JSON/CSV reports contain no source cell values. The source fingerprint identifies a particular export, not a person. No HTML or spreadsheet formula is produced from input text.

CSV cannot establish the workbook's formulas, calculated-age date, validation rules, hidden material or complete archive scope. Keep the original workbook/pages and an approved immutable snapshot. The source notes' 247 named rows, earlier 243 imported rows and estimate of approximately 600 people must be reconciled with the ledger maintainer; this tool does not assume any is the expected input count.

## Tests and next gate

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tools/membership-import -p 'test_*.py' -v
```

Tests use temporary files and fictional records. No source data or credentials are needed. Before a future writer is built, approve the full source field map, identity crosswalk, active/inactive/visitor rules, private provenance destination and durable batch/event identifiers, then rehearse idempotent imports on fictional data. Current per-form save protection is not a bulk-import pipeline.

## Compare two source snapshots before cutover

`compare_snapshots.py` compares two explicitly selected CSV exports in memory. It helps a records reviewer find observations that changed while the old ledger was still in use. It writes no files and has no import, apply, delete, network or database operation.

```sh
python3 tools/membership-import/compare_snapshots.py /approved/private/earlier.csv /approved/private/later.csv
python3 tools/membership-import/compare_snapshots.py /approved/private/earlier.csv /approved/private/later.csv --json
```

Keep the originals and any captured report in the approved private migration folder. Use immutable exports in a trusted private folder. Both inputs must be local regular files with the validated A:P layout and no symbolic link in either path; on macOS use the physical folder path rather than a symlink such as /tmp. Unknown or malformed layouts stop the comparison. The output excludes filenames, cell values and individual-row fingerprints; whole-file fingerprints identify the exact exports. A successful comparison is never approval to import.

The comparison uses all original cell text, including Column 6, uncertain dates, leading zeros, spelling and whitespace. It groups identical rows and preserves how often each occurs. Sorting the sheet therefore does not manufacture new observations. Every CSV record is accounted for, including unnamed records and blank lines; a blank line and a row containing sixteen empty cells remain different parsed records. Header whitespace and CSV quoting/line-ending changes can change the file fingerprint without changing the observed row values.

JSON lists every group with its earlier and later CSV row locators and occurrence counts. The default summary lists groups with unmatched observations, displaying up to twenty locators per side with an explicit omitted count; use --json for the complete locator lists. If two identical rows become one, the report records one unmatched earlier occurrence and retains all associated locators; it cannot know which identical row remains. It does not pair particular duplicate occurrences, deduplicate people or treat row position, membership number or a name as identity. A changed cell appears as one unmatched earlier observation and one unmatched later observation. That does not establish an edit to the same person, a new member or permission to delete anything.

Review unmatched observations against the privately preserved exports and the approved identity crosswalk. Account for source changes after the snapshot before cutover. A comparison with no unmatched observations does not establish that the workbook's formulas, validation, other tabs or handwritten archive are unchanged. Column 6, historical status rules and all identity decisions remain open. Durable batch/source-event identity, an import preview tied to approved mappings and the repeat-safe database writer are still separate work.

Status `0` means the comparison completed; status `2` means invalid arguments, unreadable/unsupported inputs or an invalid source structure. JSON mode returns a fixed diagnostic on failure. Native file permissions and the private handling of any redirected output remain the operator's responsibility. Tests use fictional temporary CSV files only.
