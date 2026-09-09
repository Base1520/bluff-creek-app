# Membership source reconciliation · September 7, 2026

This is a read-only inventory and proposed field map for the original chronological roll. It contains no member records, private spreadsheet identifiers or account details. The existing source has not been changed or imported into Creek Office.

## Verified scope

The user explicitly authorized inspecting the original workbook and making a duplicate if editing access was missing. The browser account has Editor access; General access is Restricted. No duplicate was needed for access. The connected Google integration still cannot access the workbook, despite working browser access.

The visible tab is `Sheet2`; its native table is named `Table2`. The All Sheets menu showed only that tab. This does not establish whether other source workbooks, earlier copies, handwritten books or hidden material contain additional records. Header inspection found 16 populated columns, A:P. A bounded browser copy of A2:P1309 was parsed in memory; only headers and aggregates were retained, and the copied member content was cleared from the working browser clipboard. No local source export or member screenshot was created.

| Observation | Result | Interpretation |
| --- | --- | --- |
| Rows with any name in H, I or J | 247 | Named source rows, not confirmed unique people or the whole archive |
| Last named row in the inspected range | 275 | The larger grid boundary is not a membership count |
| Named rows missing membership number B | 9 | Retain and review; do not invent numbers or drop rows |
| Named rows missing original increase number A | 0 | Completeness does not establish uniqueness |
| Repeated nonblank increase-number groups in A | 2 | Exact trimmed matches; not evidence to merge people |
| Repeated nonblank membership-number groups in B | 0 | Does not prove identity consistency across other sources |
| Repeated exact first/middle/last-name groups | 0 | Spelling variants and historical name changes remain unreviewed |
| Named rows with a value in G, `Column 6` | 247 | Meaning unknown; preserve every value |

Earlier notes mention 243 imported rows; the user estimates approximately 600 names across 70 years. Neither number has been reconciled to these 247 named rows. Do not assert a missing-person count by subtracting them. No active/inactive classification, formula/validation audit or full historical date review has been completed.

## Source field map

Headers below normalize whitespace only. Column letters identify the observed source layout; an importer must validate the actual headers before using a mapping. All proposed destinations remain unapplied.

| Column | Observed header | Proposed handling |
| --- | --- | --- |
| A | X> increase # | Preserve the original value as text and source provenance. It has repeated values and must not become the portal's unique identity. No dedicated destination exists yet. |
| B | Membership Number | `contacts.membership_number`, preserving text and blanks. Never substitute a generated row number. |
| C | Date Received | `contacts.received_date_text`; preserve the original wording. |
| D | How Received (Baptism, Letter, Statement) | `contacts.how_received`; confirm historical terminology before normalization. |
| E | Date Baptized | `contacts.baptism_date_text`; preserve uncertain dates. |
| F | Date Letter Received | Preserve in reviewed historical provenance or an approved dedicated field; no dedicated contact field exists yet. |
| G | Column 6 | Preserve unchanged under its original label. Meaning pending the ledger maintainer's explanation. |
| H | First Name | `contacts.first_name`; review uncertain readings without guessing. |
| I | Middle Name | `contacts.middle_name`; preserve spelling. |
| J | Last Name | `contacts.last_name`; retain unknown surnames as blank. |
| K | Date of Birth | `contacts.birth_date_text`; do not fabricate exact dates. |
| L | Age | Preserve the raw source value in provenance; establish how it was calculated and dated before using it. No dedicated contact field exists. |
| M | Dismissal Number | Preserve as text in reviewed historical provenance or an approved dedicated field; no dedicated contact field exists yet. |
| N | Date of Dismissal | `contacts.dismissal_date_text`; retain the original wording. |
| O | Reason for Decrease (Death, Letter Out, Erasure) | `contacts.reason_for_decrease`; confirm how the church interprets these historical terms. |
| P | Notes | Review intended staff visibility before mapping. General contact notes are viewer-readable; detailed history is admin/editor only. Preserve original notes in the approved private destination. |

None of these columns is a verified stable `legacy_member_id`. The existing generated Ledger MemberID must be reconciled through an explicit source-to-person crosswalk before import. Row positions are source locators, not durable identities. Preserve source file/tab/row references privately alongside an immutable source snapshot in an approved destination.

## Existing importer findings

A read-only review of the church's existing Apps Script found that its archive importer uses fixed column positions, generates MemberID from physical row position, and clears/replaces the destination Ledger. It ignores both source A and G. Its date helper can discard year-only or unparseable text. Other update/removal paths match on first and last name, which is insufficient for safe historical reconciliation. No script, trigger, setup, cleanup or import was run.

Do not use that importer unchanged for the office migration. A future importer needs a validated field map that preserves all source columns, a reviewed identity crosswalk, explicit status rules, and import-batch/source-event identifiers so retries can be reconciled without duplicate entries. The current prepared portal schema alone does not provide an exactly-once import pipeline.

## September 8 walkthrough

The user confirmed that `Column 6` is unknown and should be explained by the ledger maintainer during the walkthrough. Keep it intact until then. Also establish:

1. Which original, duplicate and handwritten volumes together represent the entire archive, and what explains the 243 / 247 / approximately 600 scope differences?
2. What do original increase numbers, membership numbers and dismissal numbers identify? Are reuse, gaps or missing numbers intentional?
3. What does G mean, and how should letter-received dates, age and historical removal terminology be used?
4. Which existing Ledger MemberIDs are already referenced by forms, reports or other records and must remain linked?
5. Where are the current first-time guest sheet and approved deacon visitation guidelines? What staff should be able to see detailed notes?

After those decisions, prepare an import preview and exception report with all rows accounted for, preserve the source, and review identity/status decisions before applying changes to an authorized private backend. Browser Editor permission does not activate that backend, OCR, Google write-back or external reminders.

## Read-only source preflight prepared September 7

`tools/membership-import/preflight.py` now checks a privately selected CSV against the observed A:P header/width contract and reports sanitized row-number exceptions. It preserves source text in memory and never changes or copies raw source records into the repository. Column 6, identity and active/inactive status remain unresolved. It was verified with 15 fictional tests only; no actual source export was processed. See [usage and limits](../tools/membership-import/README.md). A structural pass is not approval to import. The reviewed crosswalk, durable import-batch/source-event identities and future writer still need to be built after the source walkthrough.


## September 9 source-change review preparation

An offline two-snapshot comparison is prepared in `tools/membership-import/compare_snapshots.py`. It validates both observed layouts, compares exact original row text as a multiset and reports only whole-file fingerprints, counts and CSV record locators. Every row is accounted for, including blanks and unnamed content. Sorting does not create new observations; changed values and changed duplicate counts stay visible without inferred person matches or deletion instructions. All A:P values remain in the unchanged source files, including unknown G.

The tool has no writer, backend connection, automatic identity map or import approval. It was developed on fictional snapshots only; neither church source export has been selected or processed. Records staff must still approve the source, definitions, crosswalk, statuses and private provenance destination. Before cutover, compare the approved snapshot with the final export and reconcile each unmatched observation privately. This provides a review aid for that step, not durable batch identity or a repeat-safe import pipeline. See the [comparison instructions](../tools/membership-import/README.md#compare-two-source-snapshots-before-cutover).
