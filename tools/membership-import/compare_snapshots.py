#!/usr/bin/env python3
"""Read-only comparison of two observed membership CSV snapshots.

Exact raw row tuples are counted as multisets. Source record numbers are
locators, never person identities. No cell values enter reports or errors.
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
from pathlib import Path


# Load the exact sibling without changing the caller's import search path.
# The command writes no reports, source copies, or import bytecode.
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location(
    "_membership_comparison_preflight", Path(__file__).with_name("preflight.py")
)
p = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = p
_spec.loader.exec_module(p)

ERRORS = {
    "INVALID_ARGUMENTS": "Invalid arguments. Use --help; only two local CSV inputs and --json are supported.",
    "INVALID_LOCAL_FILE": "Choose local regular files with no symlink in either input path.",
    "INVALID_CSV_INPUT": "Could not read complete supported CSV inputs within the assessment limit.",
    "INVALID_OBSERVED_STRUCTURE": "Both snapshots must use the valid observed 16-column structure.",
}


class DeltaError(Exception):
    """A fixed diagnostic code containing no source values or input paths."""


class _Parser(p.QuietParser):
    def error(self, message: str) -> None:
        # Do not let argparse echo a private path or an unknown option value.
        raise DeltaError("INVALID_ARGUMENTS")


class _SelectedFile:
    """Give the existing bounded reader an already-verified file descriptor."""

    def __init__(self, stream):
        self.stream = stream

    def open(self, mode: str):
        if mode != "rb":
            raise DeltaError("INVALID_LOCAL_FILE")
        return self.stream


def _read_regular(path: Path) -> p.Snapshot:
    """Require a physical path without symlink components, then a regular file."""
    directory = descriptor = None
    try:
        parts = path.absolute().parts
        if len(parts) < 2:
            raise DeltaError("INVALID_LOCAL_FILE")
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        directory = os.open(parts[0], flags)
        for component in parts[1:-1]:
            next_directory = os.open(component, flags, dir_fd=directory)
            os.close(directory)
            directory = next_directory
        descriptor = os.open(
            parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=directory,
        )
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise DeltaError("INVALID_LOCAL_FILE")
        stream = os.fdopen(descriptor, "rb")
        descriptor = None
        with stream:
            return p.read_source(_SelectedFile(stream))
    except p.PreflightError:
        raise DeltaError("INVALID_CSV_INPUT") from None
    except (OSError, ValueError, AttributeError):
        raise DeltaError("INVALID_LOCAL_FILE") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if directory is not None:
            os.close(directory)


def compare_snapshots(before: p.Snapshot, after: p.Snapshot) -> dict:
    """Count exact observations; never infer edits, links, people or deletions."""
    assessments = [p.assess(snapshot) for snapshot in (before, after)]
    if not all(report["structure_valid"] for report in assessments):
        raise DeltaError("INVALID_OBSERVED_STRUCTURE")
    # Parsed CSV locators are integers. Reject malformed manually-built snapshots
    # too, so an accidental source string cannot enter a report as a locator.
    if any(type(row.number) is not int or row.number < 2
           for snapshot in (before, after) for row in snapshot.rows):
        raise DeltaError("INVALID_OBSERVED_STRUCTURE")

    grouped = {}
    for side, snapshot in (("before_rows", before), ("after_rows", after)):
        for row in snapshot.rows:
            # Dict insertion order preserves first appearance before, then after.
            # Do not strip or sort source values, even blank or unnamed records.
            group = grouped.setdefault(row.values, {"before_rows": [], "after_rows": []})
            group[side].append(row.number)

    groups = []
    counts = {
        "before_rows": len(before.rows), "after_rows": len(after.rows),
        "shared_occurrences": 0, "before_unmatched_occurrences": 0,
        "after_unmatched_occurrences": 0,
    }
    for group in grouped.values():
        before_count, after_count = len(group["before_rows"]), len(group["after_rows"])
        shared = min(before_count, after_count)
        item = {
            "kind": "shared_values" if shared else "before_only_values" if before_count else "after_only_values",
            "before_rows": group["before_rows"], "after_rows": group["after_rows"],
            "shared_occurrences": shared,
            "before_unmatched_occurrences": before_count - shared,
            "after_unmatched_occurrences": after_count - shared,
        }
        groups.append(item)
        for key in ("shared_occurrences", "before_unmatched_occurrences", "after_unmatched_occurrences"):
            counts[key] += item[key]

    return {
        "format_version": 1, "mode": "snapshot_comparison_only",
        "import_ready": False, "comparison_ready": True,
        "source_fingerprints_sha256": {"before": before.fingerprint, "after": after.fingerprint},
        "bytes_identical": before.raw == after.raw,
        "headers_identical": before.header == after.header,
        "counts": counts, "groups": groups,
        "unknowns": dict(assessments[0]["unknowns"]),
    }


def summary(report: dict) -> str:
    counts = report["counts"]
    lines = [
        "Membership snapshot comparison — COMPARISON ONLY; not ready for import.",
        "No source changes, output files, Sheet/backend connections or person matching.",
        f"Before CSV data records: {counts['before_rows']}; after: {counts['after_rows']}.",
        f"Exact shared occurrences: {counts['shared_occurrences']}.",
        f"Unmatched before occurrences: {counts['before_unmatched_occurrences']}; unmatched after: {counts['after_unmatched_occurrences']}.",
        f"Whole-file bytes identical: {report['bytes_identical']}; raw header cells identical: {report['headers_identical']}.",
        "Before whole-file SHA256: " + report["source_fingerprints_sha256"]["before"],
        "After whole-file SHA256: " + report["source_fingerprints_sha256"]["after"],
    ]
    def locators(rows: list[int]) -> str:
        shown = ", ".join(str(number) for number in rows[:20]) or "none"
        return shown + (f" (+{len(rows) - 20} omitted; use --json for all)" if len(rows) > 20 else "")
    for number, group in enumerate(report["groups"], start=1):
        if group["before_unmatched_occurrences"] or group["after_unmatched_occurrences"]:
            lines.append(
                f"Group {number} — earlier CSV rows: {locators(group['before_rows'])}; later CSV rows: {locators(group['after_rows'])}. "
                f"Shared occurrences: {group['shared_occurrences']}; unmatched earlier: {group['before_unmatched_occurrences']}; unmatched later: {group['after_unmatched_occurrences']}."
            )
    lines.extend([
        "Unmatched groups show all associated earlier/later locators, capped at 20 per list. Use --json for every group and its complete locator lists.",
        "All data records are counted, including blank and unnamed records; an empty record differs from 16 empty cells.",
        "Matching uses exact raw cell tuples: no trimming or name, identifier, date or status interpretation.",
        "Row reordering creates no unmatched occurrences. A changed cell yields unmatched observations, not an inferred edit, link or deletion.",
        "Duplicate multiplicity is retained. All group locators are kept; no particular duplicate occurrence is chosen as added or removed.",
        "Row numbers locate CSV records (header = 1), not people or physical lines inside quoted fields.",
        "Column G meaning, unique people and whole archive totals remain unknown. Identity/status rules remain unreviewed; dates remain original text.",
        "CSV does not establish workbook formulas or validation. Exit 0 confirms comparison only, never permission to import.",
    ])
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    values = list(sys.argv[1:] if argv is None else argv)
    json_requested = any(value == "--json" or value.startswith("--json=") for value in values)
    parser = _Parser(
        prog="compare_snapshots.py", allow_abbrev=False,
        description="Read-only exact-row comparison of two local membership CSV snapshots. No import or network operation.",
    )
    parser.add_argument("before", type=Path, help="Earlier local regular CSV file; no symlink path.")
    parser.add_argument("after", type=Path, help="Later local regular CSV file; no symlink path.")
    parser.add_argument("--json", action="store_true", help="Print a sanitized machine-readable report; write no output files.")
    try:
        args = parser.parse_args(values)
        report = compare_snapshots(_read_regular(args.before), _read_regular(args.after))
    except DeltaError as error:
        code = str(error) if str(error) in ERRORS else "INVALID_CSV_INPUT"
        if json_requested:
            print(json.dumps({
                "format_version": 1, "mode": "snapshot_comparison_only",
                "import_ready": False, "comparison_ready": False, "error": code,
            }))
        else:
            print(ERRORS[code], file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=True, indent=2) if args.json else summary(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
