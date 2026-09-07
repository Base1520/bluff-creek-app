#!/usr/bin/env python3
"""Offline, read-only assessment of the observed BCBC membership CSV layout.

There is deliberately no import/apply, account, network or database operation.
Reports contain counts, column letters, fixed issue codes and source row numbers.
Source values remain in memory and are never copied into reports or diagnostics.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path


HEADERS = (
    "X> increase #", "Membership Number", "Date Received",
    "How Received (Baptism, Letter, Statement)", "Date Baptized",
    "Date Letter Received", "Column 6", "First Name", "Middle Name",
    "Last Name", "Date of Birth", "Age", "Dismissal Number",
    "Date of Dismissal", "Reason for Decrease (Death, Letter Out, Erasure)", "Notes",
)
LETTERS = tuple("ABCDEFGHIJKLMNOP")
REPORT_FILES = ("membership-preflight.json", "membership-review.csv")
MAX_BYTES = 64 * 1024 * 1024
ISSUE_LABELS = {
    "HEADER_WIDTH": "Header must contain exactly 16 columns in the observed A:P order.",
    "HEADER_MISMATCH": "Header does not match the observed layout; no field mapping was applied.",
    "ROW_WIDTH": "Row does not contain exactly 16 cells; retain it for source review.",
    "UNNAMED_CONTENT": "Row has content but no name; retain it for source review.",
    "MISSING_MEMBERSHIP_NUMBER": "Named row has no membership number; do not invent one.",
    "MISSING_INCREASE_NUMBER": "Named row has no original increase number.",
    "REPEATED_INCREASE_NUMBER": "Original increase number repeats; this does not establish identity.",
    "REPEATED_MEMBERSHIP_NUMBER": "Membership number repeats; do not merge automatically.",
    "REPEATED_EXACT_NAME": "Exact trimmed name repeats; these may be different people.",
}


class PreflightError(Exception):
    """A fixed, non-source-bearing diagnostic code."""


@dataclass(frozen=True)
class SourceRow:
    number: int
    values: tuple[str, ...] = field(repr=False)


@dataclass(frozen=True)
class Snapshot:
    raw: bytes = field(repr=False)
    header: tuple[str, ...] = field(repr=False)
    rows: tuple[SourceRow, ...] = field(repr=False)

    @property
    def fingerprint(self) -> str:
        return hashlib.sha256(self.raw).hexdigest()


def read_source(path: Path) -> Snapshot:
    """Retain bytes and every parsed value; never infer numbers, dates or status."""
    try:
        with path.open("rb") as source:
            raw = source.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise PreflightError("Input exceeds the 64 MB assessment limit.")
        if b"\x00" in raw:
            raise PreflightError("Use a UTF-8, comma-separated CSV export; this input is unsupported.")
        text = raw.decode("utf-8-sig")
        # A long historical note must not be silently shortened by the CSV parser.
        previous_limit = csv.field_size_limit()
        csv.field_size_limit(MAX_BYTES)
        try:
            records = list(csv.reader(io.StringIO(text, newline=""), strict=True))
        finally:
            csv.field_size_limit(previous_limit)
    except (OSError, ValueError, UnicodeError, csv.Error):
        raise PreflightError("Could not read a complete UTF-8, comma-separated CSV. Check the local export.") from None
    if not records:
        raise PreflightError("The CSV is empty; the observed 16-column header is required.")
    return Snapshot(raw, tuple(records[0]), tuple(
        SourceRow(number, tuple(values)) for number, values in enumerate(records[1:], start=2)
    ))


def _header_key(value: str) -> str:
    # Source observations normalized whitespace only; retain the original in Snapshot.
    return " ".join(value.split())


def assess(snapshot: Snapshot) -> dict:
    """Return a sanitized report. No source field value enters this result."""
    issues: list[dict] = []

    def issue(code: str, rows: list[int], columns: list[str] | None = None) -> None:
        item = {"code": code, "rows": rows}
        if columns:
            item["columns"] = columns
        issues.append(item)

    header_valid = len(snapshot.header) == len(HEADERS)
    if not header_valid:
        issue("HEADER_WIDTH", [1])
    else:
        mismatches = [LETTERS[i] for i, (actual, expected) in enumerate(zip(snapshot.header, HEADERS))
                      if _header_key(actual) != expected]
        if mismatches:
            header_valid = False
            issue("HEADER_MISMATCH", [1], mismatches)

    counts = {
        "data_rows": len(snapshot.rows), "blank_rows": 0, "nonempty_rows": 0,
        "named_rows": 0, "unnamed_nonempty_rows": 0, "unclassified_nonempty_rows": 0,
        "invalid_width_rows": 0, "missing_membership_number": 0, "missing_increase_number": 0,
        "column_g_populated_rows": 0, "column_g_named_populated_rows": 0,
        "identity_unreviewed_rows": 0, "status_unknown_rows": 0,
    }
    populated = {letter: 0 for letter in LETTERS}
    groups: dict[str, dict] = {
        "REPEATED_INCREASE_NUMBER": defaultdict(list),
        "REPEATED_MEMBERSHIP_NUMBER": defaultdict(list),
        "REPEATED_EXACT_NAME": defaultdict(list),
    }
    review_rows = []
    for row in snapshot.rows:
        values = row.values
        # Whitespace-only values still exist in Snapshot; trimming is only for classification.
        nonempty = any(value.strip() for value in values)
        counts["nonempty_rows" if nonempty else "blank_rows"] += 1
        valid_width = len(values) == 16 or len(values) == 0
        if not valid_width:
            counts["invalid_width_rows"] += 1
            issue("ROW_WIDTH", [row.number])
        row_columns = [LETTERS[i] for i, value in enumerate(values[:16]) if value.strip()]
        for letter in row_columns:
            populated[letter] += 1
        named = None
        classification = "blank" if not nonempty else "unclassified"
        if nonempty and header_valid and len(values) == 16:
            named = any(values[i].strip() for i in (7, 8, 9))
            classification = "named" if named else "unnamed_content"
            counts["named_rows" if named else "unnamed_nonempty_rows"] += 1
            if values[6].strip():
                counts["column_g_populated_rows"] += 1
            if not named:
                issue("UNNAMED_CONTENT", [row.number])
            else:
                counts["identity_unreviewed_rows"] += 1
                counts["status_unknown_rows"] += 1
                if values[6].strip():
                    counts["column_g_named_populated_rows"] += 1
                for column, count, code in ((1, "missing_membership_number", "MISSING_MEMBERSHIP_NUMBER"),
                                            (0, "missing_increase_number", "MISSING_INCREASE_NUMBER")):
                    if not values[column].strip():
                        counts[count] += 1
                        issue(code, [row.number])
                for column, code in ((0, "REPEATED_INCREASE_NUMBER"), (1, "REPEATED_MEMBERSHIP_NUMBER")):
                    if values[column].strip():
                        groups[code][values[column].strip()].append(row.number)
                groups["REPEATED_EXACT_NAME"][tuple(values[i].strip() for i in (7, 8, 9))].append(row.number)
        elif nonempty:
            counts["unclassified_nonempty_rows"] += 1
        review_rows.append({
            "source_row": row.number, "source_cell_count": len(values),
            "populated_columns": row_columns, "classification": classification,
            "identity": "unreviewed" if named else "not_assessed",
            "status": "unknown", "issues": [],
        })

    for code, values in groups.items():
        repeated = [rows for rows in values.values() if len(rows) > 1]
        counts[code.lower() + "_groups"] = len(repeated)
        for rows in repeated:
            issue(code, rows)
    row_issues = defaultdict(list)
    for item in issues:
        for number in item["rows"]:
            row_issues[number].append(item["code"])
    for row in review_rows:
        row["issues"] = row_issues[row["source_row"]]

    if not header_valid:
        # Zero would incorrectly imply that a changed layout contains no names or exceptions.
        for name in ("named_rows", "unnamed_nonempty_rows", "missing_membership_number",
                     "missing_increase_number", "column_g_populated_rows", "column_g_named_populated_rows",
                     "identity_unreviewed_rows", "status_unknown_rows",
                     *(code.lower() + "_groups" for code in groups)):
            counts[name] = None

    return {
        "format_version": 1, "mode": "dry_run_only", "import_ready": False,
        "source_fingerprint_sha256": snapshot.fingerprint,
        "header_valid": header_valid,
        "structure_valid": header_valid and counts["invalid_width_rows"] == 0,
        "counts": counts, "populated_cells_by_position": populated,
        "accounted_rows": len(review_rows),
        "unknowns": {
            "column_g_meaning": "unknown_preserve_as_Column_6",
            "unique_people_total": "unknown", "whole_archive_total": "unknown",
            "identity_crosswalk": "not_reviewed", "membership_status_rules": "not_reviewed",
            "dates": "original_text_only_not_interpreted",
            "workbook_formulas_and_validation": "not_established_by_csv",
        },
        "preservation": {
            "input_unchanged": True, "raw_values_retained_in_memory": True,
            "raw_source_copy_written": False, "source_rows_merged": 0,
            "raw_values_in_report": False,
            "source_fields_needing_destination_review": ["A", "F", "G", "L", "M", "P"],
        },
        "issues": issues, "row_review": review_rows,
    }


def _git_ancestor(path: Path) -> bool:
    for parent in (path, *path.parents):
        marker = parent / ".git"
        if marker.exists() or marker.is_symlink():
            return True
        # Also exclude a bare repository, which has no .git directory.
        if (parent / "HEAD").is_file() and (parent / "objects").is_dir() and (parent / "refs").is_dir():
            return True
    return False


def write_reports(report: dict, directory: Path) -> None:
    """Write only sanitized reports to an explicitly chosen non-repository folder."""
    try:
        destination = directory.expanduser().resolve()
        if _git_ancestor(destination):
            raise PreflightError("Report output must be outside every Git repository.")
        if destination.exists() and not destination.is_dir():
            raise PreflightError("Choose a directory for report output.")
        if any((destination / name).exists() or (destination / name).is_symlink() for name in REPORT_FILES):
            raise PreflightError("A report already exists in that folder. Choose a new folder; nothing is overwritten.")
        destination.mkdir(parents=True, exist_ok=True, mode=0o700)
        output = io.StringIO(newline="")
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(["source_row", "source_cell_count", "populated_columns", "classification", "identity", "status", "issues"])
        for row in report["row_review"]:
            writer.writerow([row["source_row"], row["source_cell_count"], " ".join(row["populated_columns"]),
                             row["classification"], row["identity"], row["status"], " ".join(row["issues"])])
        payloads = (json.dumps(report, ensure_ascii=True, indent=2) + "\n", output.getvalue())
        for name, contents in zip(REPORT_FILES, payloads):
            # Exclusive creation also blocks a concurrent overwrite or a file symlink.
            descriptor = os.open(destination / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as target:
                target.write(contents)
    except (OSError, ValueError, RuntimeError):
        raise PreflightError("Could not create reports. Check the chosen folder; existing files are never replaced.") from None


def _row_list(rows: list[int]) -> str:
    shown = ", ".join(str(number) for number in rows[:20])
    return shown + (f" (+{len(rows) - 20} more)" if len(rows) > 20 else "")


def summary(report: dict) -> str:
    counts = report["counts"]
    def count(name: str) -> str:
        value = counts[name]
        return "NOT ASSESSED" if value is None else str(value)
    lines = [
        "Membership preflight — DRY RUN ONLY; not approved for import.",
        "No Sheet/backend connection, source changes, date/status inference or person merging.",
        f"Structure: {'valid observed A:P layout' if report['structure_valid'] else 'NEEDS SOURCE REVIEW; do not map automatically'}.",
        f"Data rows accounted for: {counts['data_rows']} ({counts['blank_rows']} blank; {counts['nonempty_rows']} nonempty).",
        f"Named rows: {count('named_rows')}; unnamed with content: {count('unnamed_nonempty_rows')}; unclassified: {counts['unclassified_nonempty_rows']}.",
        f"Missing membership number: {count('missing_membership_number')}; missing increase number: {count('missing_increase_number')}.",
        f"Column G meaning: UNKNOWN; populated in {count('column_g_named_populated_rows')} named rows (no interpretation).",
        f"Identity unreviewed: {count('identity_unreviewed_rows')}; named-row status unknown: {count('status_unknown_rows')}.",
        "Unique people and whole archive totals remain UNKNOWN; rows are not person IDs.",
        "Dates stay as written. CSV does not establish original workbook formulas or validation.",
    ]
    for item in report["issues"]:
        columns = " Columns: " + ", ".join(item["columns"]) + "." if item.get("columns") else ""
        lines.append(f"{item['code']} — source row(s) {_row_list(item['rows'])}. {ISSUE_LABELS[item['code']]}{columns}")
    lines.append("Source row numbers count CSV records (header = 1), including blank rows; quoted newlines do not create extra rows.")
    lines.append("Original values remain in the unchanged input; these reports are review aids, not an archive backup.")
    return "\n".join(lines)


class QuietParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        # argparse's normal error can echo an unrecognized value or private filename.
        self.exit(2, "Invalid arguments. Use --help; this tool supports only local CSV assessment and optional sanitized reports.\n")


def main(argv: list[str] | None = None) -> int:
    parser = QuietParser(description="Read-only local membership CSV assessment. No import or network operation.")
    parser.add_argument("source", type=Path, help="Explicit local UTF-8 CSV export; source is never changed.")
    parser.add_argument("--output-dir", type=Path, help="Optional new report folder outside every Git repository. No raw source values are copied.")
    arguments = parser.parse_args(argv)
    try:
        report = assess(read_source(arguments.source))
    except PreflightError as error:
        print(str(error), file=sys.stderr)
        return 2
    print(summary(report))
    if arguments.output_dir is not None:
        try:
            write_reports(report, arguments.output_dir)
        except PreflightError as error:
            print(str(error), file=sys.stderr)
            return 3
        print("Sanitized reports written to the explicitly chosen folder. No raw source copy was written.")
    return 0 if report["structure_valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
