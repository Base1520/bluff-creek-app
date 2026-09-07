"""Fictional-only regression tests. No church record or account is accessed."""

import contextlib
import csv
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import preflight as p


def fictional_row(**changes):
    values = ["001", "0007", "Summer 1956; day [unclear]", "As written", "1957?", "1960",
              "SYNTHETIC-UNKNOWN-G", "Fictional", "", "Example", "19??", "As recorded", "009", "", "", "Synthetic note"]
    for letter, value in changes.items():
        values[p.LETTERS.index(letter)] = value
    return values


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)

    def source(self, rows, headers=p.HEADERS, name="synthetic.csv"):
        path = self.folder / name
        with path.open("w", encoding="utf-8", newline="") as target:
            writer = csv.writer(target)
            writer.writerow(headers)
            writer.writerows(rows)
        return path

    def run_cli(self, *arguments):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = p.main([str(value) for value in arguments])
        return result, stdout.getvalue(), stderr.getvalue()

    def test_every_cell_remains_text_including_unknown_fields_and_date_wording(self):
        values = fictional_row(A="0001 ", B="", F=" 1900? ", G="not an interpreted status",
                               J="", L=" 01 ", M="0009", N="summer 1964", O="Historical term", P="  Original wording  ")
        path = self.source([values])
        before = path.read_bytes()
        snapshot = p.read_source(path)
        report = p.assess(snapshot)
        self.assertEqual(snapshot.raw, before)
        self.assertEqual(snapshot.rows[0].values, tuple(values))
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(report["counts"]["named_rows"], 1)
        self.assertEqual(report["counts"]["missing_membership_number"], 1)
        self.assertEqual(report["unknowns"]["column_g_meaning"], "unknown_preserve_as_Column_6")
        self.assertEqual(report["row_review"][0]["status"], "unknown")
        self.assertEqual(report["row_review"][0]["identity"], "unreviewed")
        self.assertFalse(report["import_ready"])
        self.assertEqual(report["preservation"]["source_rows_merged"], 0)

    def test_quoted_commas_newlines_unicode_and_bom_preserve_records(self):
        values = fictional_row(H="Fictional Élodie", P='Synthetic comma, quote " and\nsecond line')
        path = self.source([values, [], fictional_row(A="002", B="0008", H="Fictional Rowan")])
        path.write_bytes(b"\xef\xbb\xbf" + path.read_bytes())
        snapshot = p.read_source(path)
        self.assertEqual(snapshot.rows[0].values, tuple(values))
        self.assertEqual([row.number for row in snapshot.rows], [2, 3, 4])
        self.assertEqual(p.assess(snapshot)["counts"]["named_rows"], 2)
        self.assertEqual(p.assess(snapshot)["counts"]["blank_rows"], 1)

    def test_accounts_for_blank_unnamed_short_and_extra_width_rows(self):
        unnamed = [""] * 16
        unnamed[15] = "Synthetic unnamed source note"
        rows = [fictional_row(), unnamed, [""] * 16, [], ["Synthetic short row"], fictional_row() + ["Extra synthetic cell"]]
        report = p.assess(p.read_source(self.source(rows)))
        counts = report["counts"]
        self.assertEqual(counts["data_rows"], 6)
        self.assertEqual(counts["blank_rows"], 2)
        self.assertEqual(counts["nonempty_rows"], 4)
        self.assertEqual(counts["named_rows"], 1)
        self.assertEqual(counts["unnamed_nonempty_rows"], 1)
        self.assertEqual(counts["unclassified_nonempty_rows"], 2)
        self.assertEqual(counts["invalid_width_rows"], 2)
        self.assertEqual(report["accounted_rows"], 6)
        self.assertEqual([row["source_row"] for row in report["row_review"]], list(range(2, 8)))
        self.assertFalse(report["structure_valid"])

    def test_invalid_headers_block_mapping_without_echoing_header_contents(self):
        variants = [list(p.HEADERS[:-1]), [*p.HEADERS, "SYNTHETIC-PRIVATE-EXTRA"],
                    [p.HEADERS[1], p.HEADERS[0], *p.HEADERS[2:]],
                    [*p.HEADERS[:6], "SYNTHETIC-PRIVATE-HEADER", *p.HEADERS[7:]],
                    [*p.HEADERS[:6], p.HEADERS[0], *p.HEADERS[7:]],
                    [*p.HEADERS[:7], "first name", *p.HEADERS[8:]]]
        for headers in variants:
            with self.subTest(width=len(headers)):
                path = self.source([fictional_row()], headers=headers)
                report = p.assess(p.read_source(path))
                self.assertFalse(report["header_valid"])
                self.assertIsNone(report["counts"]["named_rows"])
                self.assertEqual(report["counts"]["unclassified_nonempty_rows"], 1)
                self.assertEqual(report["row_review"][0]["identity"], "not_assessed")
                self.assertNotIn("SYNTHETIC-PRIVATE", json.dumps(report))
                status, stdout, stderr = self.run_cli(path)
                self.assertEqual(status, 2)
                self.assertIn("NOT ASSESSED", stdout)
                self.assertNotIn("SYNTHETIC-PRIVATE", stdout + stderr)

    def test_header_whitespace_only_normalization_keeps_original_header(self):
        header = tuple("  " + value.replace(" ", "\n ") + "  " for value in p.HEADERS)
        snapshot = p.read_source(self.source([fictional_row()], headers=header))
        self.assertEqual(snapshot.header, header)
        self.assertTrue(p.assess(snapshot)["header_valid"])

    def test_duplicate_ids_and_homonyms_are_flags_not_merges(self):
        rows = [fictional_row(A=" 004 ", B="0002"), fictional_row(A="004", B="0002"),
                fictional_row(A="", B="", H="Fictional variant", J="Example-Synthetic")]
        report = p.assess(p.read_source(self.source(rows)))
        self.assertEqual(report["counts"]["named_rows"], 3)
        self.assertEqual(report["counts"]["identity_unreviewed_rows"], 3)
        self.assertEqual(report["counts"]["status_unknown_rows"], 3)
        for name in ("repeated_increase_number_groups", "repeated_membership_number_groups", "repeated_exact_name_groups"):
            self.assertEqual(report["counts"][name], 1)
        grouped = [issue for issue in report["issues"] if issue["code"].startswith("REPEATED_")]
        self.assertTrue(all(issue["rows"] == [2, 3] for issue in grouped))
        self.assertEqual(len(report["row_review"]), 3)
        self.assertEqual(report["preservation"]["source_rows_merged"], 0)

    def test_default_mode_writes_nothing_and_emits_no_source_values(self):
        private_marker = "SYNTHETIC-PRIVATE-SENTINEL"
        path = self.source([fictional_row(H=private_marker, G=private_marker, P=private_marker)], name=private_marker + ".csv")
        before = sorted(self.folder.iterdir())
        status, stdout, stderr = self.run_cli(path)
        self.assertEqual(status, 0)
        self.assertEqual(stderr, "")
        self.assertIn("DRY RUN ONLY", stdout)
        self.assertNotIn(private_marker, stdout + stderr)
        self.assertNotIn(str(path), stdout + stderr)
        self.assertEqual(sorted(self.folder.iterdir()), before)

    def test_explicit_reports_are_redacted_formula_safe_and_repeatable(self):
        values = fictional_row(H="=SYNTHETIC_FORMULA()", G="<script>SYNTHETIC_HTML</script>",
                               P="SYNTHETIC-PRIVATE-NOTE", A="+SYNTHETIC_FORMULA", B="@SYNTHETIC")
        snapshot = p.read_source(self.source([values]))
        first, second = p.assess(snapshot), p.assess(snapshot)
        self.assertEqual(first, second)
        destination = self.folder / "private-review"
        p.write_reports(first, destination)
        contents = "\n".join((destination / filename).read_text() for filename in p.REPORT_FILES)
        for marker in ("SYNTHETIC", "<script>", "=SYNTHETIC", "@SYNTHETIC"):
            self.assertNotIn(marker, contents)
        loaded = json.loads((destination / p.REPORT_FILES[0]).read_text())
        self.assertEqual(loaded, first)
        with (destination / p.REPORT_FILES[1]).open(newline="") as source:
            cells = [value for row in csv.reader(source) for value in row]
        self.assertFalse(any(value.startswith(("=", "+", "-", "@")) for value in cells))
        self.assertEqual(sorted(path.name for path in destination.iterdir()), sorted(p.REPORT_FILES))
        if os.name == "posix":
            self.assertTrue(all((destination / name).stat().st_mode & 0o077 == 0 for name in p.REPORT_FILES))

    def test_output_refuses_git_repository_worktree_bare_and_symlink_targets(self):
        report = p.assess(p.read_source(self.source([fictional_row()])))
        for name, kind in (("repository", "directory"), ("worktree", "file"), ("bare", "bare")):
            git = self.folder / name
            git.mkdir()
            if kind == "directory":
                (git / ".git").mkdir()
            elif kind == "file":
                (git / ".git").write_text("gitdir: synthetic-local-marker")
            else:
                (git / "HEAD").write_text("synthetic")
                (git / "objects").mkdir()
                (git / "refs").mkdir()
            with self.subTest(kind=kind), self.assertRaisesRegex(p.PreflightError, "outside every Git"):
                p.write_reports(report, git / "nested" / "review")
            self.assertFalse((git / "nested").exists())
        link = self.folder / "linked-output"
        link.symlink_to(self.folder / "repository", target_is_directory=True)
        with self.assertRaisesRegex(p.PreflightError, "outside every Git"):
            p.write_reports(report, link / "nested-review")
        self.assertFalse((self.folder / "repository" / "nested-review").exists())

    def test_existing_or_symlink_report_is_never_overwritten(self):
        report = p.assess(p.read_source(self.source([fictional_row()])))
        destination = self.folder / "review"
        destination.mkdir()
        saved = destination / p.REPORT_FILES[1]
        saved.write_text("Existing synthetic report")
        with self.assertRaisesRegex(p.PreflightError, "already exists"):
            p.write_reports(report, destination)
        self.assertEqual(saved.read_text(), "Existing synthetic report")
        self.assertFalse((destination / p.REPORT_FILES[0]).exists())
        saved.unlink()
        target = self.folder / "synthetic-target"
        target.write_text("Preserve synthetic target")
        saved.symlink_to(target)
        with self.assertRaisesRegex(p.PreflightError, "already exists"):
            p.write_reports(report, destination)
        self.assertEqual(target.read_text(), "Preserve synthetic target")

    def test_empty_malformed_encoding_and_private_filename_errors_are_redacted(self):
        for content in (b"", b'"SYNTHETIC-PRIVATE-UNFINISHED', b"\xffinvalid", b"\x00unsupported"):
            with self.subTest(content_length=len(content)):
                path = self.folder / "SYNTHETIC-PRIVATE-PATH.csv"
                path.write_bytes(content)
                status, stdout, stderr = self.run_cli(path)
                self.assertEqual(status, 2)
                self.assertEqual(stdout, "")
                self.assertNotIn("SYNTHETIC-PRIVATE", stderr)
        status, stdout, stderr = self.run_cli(self.folder / "SYNTHETIC-PRIVATE-MISSING.csv")
        self.assertEqual(status, 2)
        self.assertNotIn("SYNTHETIC-PRIVATE", stdout + stderr)

    def test_large_notes_and_more_than_one_thousand_records_are_not_truncated(self):
        note = "Synthetic long source wording. " * 6000
        rows = [fictional_row(A=str(i), B=str(i), H="Fictional " + str(i), P=note if i == 1004 else "") for i in range(1005)]
        snapshot = p.read_source(self.source(rows))
        report = p.assess(snapshot)
        self.assertEqual(report["counts"]["named_rows"], 1005)
        self.assertEqual(report["accounted_rows"], 1005)
        self.assertEqual(snapshot.rows[-1].values[15], note)

    def test_empty_data_is_structurally_valid_but_never_import_ready(self):
        report = p.assess(p.read_source(self.source([])))
        self.assertTrue(report["structure_valid"])
        self.assertEqual(report["accounted_rows"], 0)
        self.assertFalse(report["import_ready"])
        self.assertEqual(report["unknowns"]["whole_archive_total"], "unknown")

    def test_cli_has_no_apply_option_and_does_not_echo_rejected_value(self):
        path = self.source([fictional_row()])
        result = subprocess.run([sys.executable, str(Path(p.__file__)), str(path), "--apply=SYNTHETIC-PRIVATE-ARG"],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("SYNTHETIC-PRIVATE", result.stdout + result.stderr)
        self.assertIn("Invalid arguments", result.stderr)

    def test_cli_output_failure_is_distinct_from_input_validation(self):
        path = self.source([fictional_row()])
        git = self.folder / "repo"
        (git / ".git").mkdir(parents=True)
        status, stdout, stderr = self.run_cli(path, "--output-dir", git / "reports")
        self.assertEqual(status, 3)
        self.assertIn("DRY RUN ONLY", stdout)
        self.assertIn("outside every Git", stderr)
        self.assertFalse((git / "reports").exists())


if __name__ == "__main__":
    unittest.main()
