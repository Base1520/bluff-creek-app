"""Fictional, offline comparison tests; no church source or person is accessed."""
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
import preflight as p
import compare_snapshots as delta


GROUP_KEYS = {'kind', 'before_rows', 'after_rows', 'shared_occurrences',
              'before_unmatched_occurrences', 'after_unmatched_occurrences'}
COUNT_KEYS = {'before_rows', 'after_rows', 'shared_occurrences',
              'before_unmatched_occurrences', 'after_unmatched_occurrences'}


def fictional_row(marker='SYNTHETIC-A'):
    return ['0001', '0007', 'Summer 1956; day [unclear]', 'As written', '1957?',
            ' 1960? ', marker + '-UNKNOWN-G', marker + '-FIRST', '', marker + '-LAST',
            '19??', ' 01 ', '0009', 'summer 1964', 'Original term', marker + '-NOTE']


class SnapshotComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fictional-snapshot-comparison-', dir='/private/tmp')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.sequence = 0

    def source(self, rows, *, header=p.HEADERS, bom=False, newline='\r\n', quoting=csv.QUOTE_MINIMAL):
        self.sequence += 1
        path = self.folder / ('SYNTHETIC-PRIVATE-SOURCE-' + str(self.sequence) + '.csv')
        output = io.StringIO(newline='')
        writer = csv.writer(output, lineterminator=newline, quoting=quoting)
        writer.writerow(header)
        writer.writerows(rows)
        path.write_bytes((b'\xef\xbb\xbf' if bom else b'') + output.getvalue().encode('utf-8'))
        return path

    def compare(self, before, after):
        return delta.compare_snapshots(p.read_source(before), p.read_source(after))

    def inventory(self):
        result = {}
        for path in sorted(self.folder.rglob('*')):
            info = path.lstat()
            entry = [stat.S_IMODE(info.st_mode), info.st_size, info.st_mtime_ns, info.st_nlink]
            if stat.S_ISLNK(info.st_mode):
                entry.append(os.readlink(path))
            elif stat.S_ISREG(info.st_mode):
                entry.append(hashlib.sha256(path.read_bytes()).hexdigest())
            result[str(path.relative_to(self.folder))] = entry
        return result

    def run_cli(self, *arguments):
        return subprocess.run([sys.executable, '-B', str(Path(delta.__file__)), *map(str, arguments)],
                              capture_output=True, text=True, timeout=4,
                              env={'PATH': os.defpath, 'PYTHONDONTWRITEBYTECODE': '1'})

    def conserved(self, report, before, after):
        counts = report['counts']
        self.assertEqual(set(counts), COUNT_KEYS)
        self.assertEqual(counts['before_rows'], before)
        self.assertEqual(counts['after_rows'], after)
        self.assertEqual(counts['shared_occurrences'] + counts['before_unmatched_occurrences'], before)
        self.assertEqual(counts['shared_occurrences'] + counts['after_unmatched_occurrences'], after)
        before_positions, after_positions = [], []
        for group in report['groups']:
            self.assertEqual(set(group), GROUP_KEYS, 'no cells, hashes, row mappings, or identified surplus occurrence belongs in a group')
            self.assertIn(group['kind'], {'shared_values', 'before_only_values', 'after_only_values'})
            before_positions.extend(group['before_rows'])
            after_positions.extend(group['after_rows'])
            self.assertEqual(group['shared_occurrences'], min(len(group['before_rows']), len(group['after_rows'])))
            self.assertEqual(group['shared_occurrences'] + group['before_unmatched_occurrences'], len(group['before_rows']))
            self.assertEqual(group['shared_occurrences'] + group['after_unmatched_occurrences'], len(group['after_rows']))
        self.assertEqual(sorted(before_positions), list(range(2, before + 2)))
        self.assertEqual(sorted(after_positions), list(range(2, after + 2)))
        for key in ['shared_occurrences', 'before_unmatched_occurrences', 'after_unmatched_occurrences']:
            self.assertEqual(sum(group[key] for group in report['groups']), counts[key])
        self.assertEqual(report['mode'], 'snapshot_comparison_only')
        self.assertIs(report['import_ready'], False)
        self.assertIs(report['comparison_ready'], True)

    def failure(self, result, *private_markers):
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, '')
        report = json.loads(result.stdout)
        self.assertEqual(set(report), {'format_version', 'mode', 'import_ready', 'comparison_ready', 'error'})
        self.assertEqual(report['format_version'], 1)
        self.assertEqual(report['mode'], 'snapshot_comparison_only')
        self.assertIs(report['import_ready'], False)
        self.assertIs(report['comparison_ready'], False)
        self.assertRegex(report['error'], r'^[A-Z][A-Z0-9_]*$')
        for marker in [str(self.folder), 'SYNTHETIC-PRIVATE', 'Traceback', *private_markers]:
            self.assertNotIn(marker, result.stdout + result.stderr)

    def test_identical_bytes_are_compared_but_never_become_import_approval(self):
        source = self.source([fictional_row(), [], [''] * 16])
        before = self.inventory()
        report = self.compare(source, source)
        self.conserved(report, 3, 3)
        self.assertTrue(report['bytes_identical'])
        self.assertTrue(report['headers_identical'])
        self.assertEqual(report['counts']['shared_occurrences'], 3)
        fingerprint = hashlib.sha256(source.read_bytes()).hexdigest()
        self.assertEqual(report['source_fingerprints_sha256'], {'before': fingerprint, 'after': fingerprint})
        self.assertEqual(report['unknowns'], p.assess(p.read_source(source))['unknowns'])
        self.assertEqual(self.inventory(), before)

    def test_reordering_records_changes_positions_without_inventing_changed_people(self):
        a, b, c = (fictional_row('SYNTHETIC-' + letter) for letter in 'ABC')
        report = self.compare(self.source([a, b, c]), self.source([c, a, b]))
        self.conserved(report, 3, 3)
        self.assertEqual(report['counts']['shared_occurrences'], 3)
        self.assertEqual({tuple(group['before_rows']): tuple(group['after_rows']) for group in report['groups']},
                         {(2,): (3,), (3,): (4,), (4,): (2,)})
        self.assertTrue(all(group['kind'] == 'shared_values' for group in report['groups']))
        self.assertFalse(report['bytes_identical'])

    def test_duplicate_multiplicity_does_not_choose_an_arbitrary_surplus_row(self):
        a, b = fictional_row(), fictional_row('SYNTHETIC-B')
        report = self.compare(self.source([a, a, b]), self.source([a, b, b]))
        self.conserved(report, 3, 3)
        by_before = {tuple(group['before_rows']): group for group in report['groups']}
        self.assertEqual(by_before[(2, 3)], {'kind': 'shared_values', 'before_rows': [2, 3], 'after_rows': [2],
                         'shared_occurrences': 1, 'before_unmatched_occurrences': 1, 'after_unmatched_occurrences': 0})
        self.assertEqual(by_before[(4,)], {'kind': 'shared_values', 'before_rows': [4], 'after_rows': [3, 4],
                         'shared_occurrences': 1, 'before_unmatched_occurrences': 0, 'after_unmatched_occurrences': 1})

    def test_one_changed_cell_is_two_value_groups_not_an_identified_edit(self):
        before = fictional_row()
        after = before.copy()
        after[15] = 'SYNTHETIC-REPLACEMENT-NOTE'
        report = self.compare(self.source([before]), self.source([after]))
        self.conserved(report, 1, 1)
        self.assertEqual(report['counts']['shared_occurrences'], 0)
        self.assertEqual({group['kind'] for group in report['groups']}, {'before_only_values', 'after_only_values'})

    def test_all_sixteen_raw_cells_preserve_leading_zeros_unknown_g_dates_and_whitespace(self):
        original = fictional_row()
        source = self.source([original])
        snapshot = p.read_source(source)
        for index in range(16):
            with self.subTest(column=p.LETTERS[index]):
                changed = original.copy()
                changed[index] += ' '
                after = p.read_source(self.source([changed]))
                report = delta.compare_snapshots(snapshot, after)
                self.conserved(report, 1, 1)
                self.assertEqual(report['counts']['shared_occurrences'], 0, 'trimming or field-specific interpretation loses this exact change')
                self.assertEqual(snapshot.rows[0].values, tuple(original))
                self.assertEqual(after.rows[0].values, tuple(changed))

    def test_unnamed_content_blank_records_and_sixteen_empty_cells_are_separate_values(self):
        unnamed = [''] * 16
        unnamed[6], unnamed[15] = 'SYNTHETIC-UNKNOWN-G', 'SYNTHETIC-UNNAMED-NOTE'
        report = self.compare(self.source([[], [''] * 16, unnamed, []]), self.source([unnamed, [''] * 16, []]))
        self.conserved(report, 4, 3)
        self.assertEqual(len(report['groups']), 3)
        by_before = {tuple(group['before_rows']): group for group in report['groups']}
        self.assertEqual(by_before[(2, 5)]['after_rows'], [4])
        self.assertEqual(by_before[(2, 5)]['before_unmatched_occurrences'], 1)
        self.assertEqual(by_before[(3,)]['after_rows'], [3])
        self.assertEqual(by_before[(4,)]['after_rows'], [2])

    def test_header_only_snapshots_and_one_sided_additions_account_for_every_record(self):
        empty = self.source([])
        populated = self.source([fictional_row(), []])
        for before, after, expected in [(empty, empty, (0, 0)), (empty, populated, (0, 2)), (populated, empty, (2, 0))]:
            with self.subTest(counts=expected):
                report = self.compare(before, after)
                self.conserved(report, *expected)
                self.assertEqual(report['counts']['shared_occurrences'], 0)

    def test_bom_csv_quoting_line_endings_and_multiline_cells_keep_logical_records(self):
        row = fictional_row()
        row[7], row[15] = 'SYNTHETIC-Élodie', 'SYNTHETIC comma, quote " and\nsecond line'
        a = self.source([row, []], newline='\n')
        b = self.source([row, []], bom=True, quoting=csv.QUOTE_ALL)
        report = self.compare(a, b)
        self.conserved(report, 2, 2)
        self.assertEqual(report['counts']['shared_occurrences'], 2)
        self.assertFalse(report['bytes_identical'])
        self.assertTrue(report['headers_identical'])
        self.assertEqual([item.number for item in p.read_source(a).rows], [2, 3])

    def test_allowed_header_spacing_differences_remain_visible_without_remapping_cells(self):
        header = tuple('  ' + value.replace(' ', '\n ') + '  ' for value in p.HEADERS)
        report = self.compare(self.source([fictional_row()]), self.source([fictional_row()], header=header))
        self.conserved(report, 1, 1)
        self.assertFalse(report['headers_identical'])
        self.assertEqual(report['counts']['shared_occurrences'], 1)

    def test_invalid_header_or_record_width_refuses_either_snapshot_without_source_echo(self):
        valid = p.read_source(self.source([fictional_row()]))
        malformed = [self.source([fictional_row()], header=p.HEADERS[:-1]),
                     self.source([fictional_row()], header=(*p.HEADERS[:6], 'SYNTHETIC-PRIVATE-HEADER', *p.HEADERS[7:])),
                     self.source([['SYNTHETIC-PRIVATE-SHORT']]), self.source([fictional_row() + ['SYNTHETIC-PRIVATE-EXTRA']])]
        for path in malformed:
            invalid = p.read_source(path)
            for before, after in [(invalid, valid), (valid, invalid)]:
                with self.subTest(path=path.name), self.assertRaises(delta.DeltaError) as failure:
                    delta.compare_snapshots(before, after)
                self.assertEqual(str(failure.exception), 'INVALID_OBSERVED_STRUCTURE')

    def test_report_is_redacted_without_per_row_hashes_and_cli_never_writes_sources(self):
        before = self.source([fictional_row('SYNTHETIC-PRIVATE-BEFORE')])
        after = self.source([fictional_row('SYNTHETIC-PRIVATE-AFTER')])
        inventory = self.inventory()
        result = self.run_cli(before, after, '--json')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, '')
        report = json.loads(result.stdout)
        self.conserved(report, 1, 1)
        self.assertEqual(report, self.compare(before, after))
        for private in ['SYNTHETIC-PRIVATE', str(self.folder), *p.HEADERS]:
            self.assertNotIn(private, result.stdout)
        hashes = re.findall(r'[0-9a-f]{64}', result.stdout)
        self.assertCountEqual(hashes, list(report['source_fingerprints_sha256'].values()))
        default = self.run_cli(before, after)
        self.assertEqual(default.returncode, 0)
        self.assertNotIn('SYNTHETIC-PRIVATE', default.stdout + default.stderr)
        self.assertEqual(self.inventory(), inventory)

    def test_human_summary_locates_unmatched_values_and_bounds_duplicate_lists_without_losing_json_occurrences(self):
        before = fictional_row('SYNTHETIC-PRIVATE-DISPLAY')
        after = before.copy()
        after[6] = 'SYNTHETIC-PRIVATE-CHANGED-G'
        report = self.compare(self.source([before]), self.source([after]))
        human = delta.summary(report)
        lines = [line for line in human.splitlines() if line.startswith('Group ')]
        self.assertEqual(len(lines), 2)

        def group_information(line):
            match = re.search(r'earlier CSV rows: (.*); later CSV rows: (.*)\. Shared occurrences: (\d+); unmatched earlier: (\d+); unmatched later: (\d+)', line)
            self.assertIsNotNone(match)
            return (*match.group(1, 2), *map(int, match.group(3, 4, 5)))

        self.assertCountEqual([group_information(line) for line in lines], [('2', 'none', 0, 1, 0), ('none', '2', 0, 0, 1)])
        self.assertNotIn('SYNTHETIC-PRIVATE', human)

        duplicate = self.compare(self.source([before] * 25), self.source([before] * 24))
        self.conserved(duplicate, 25, 24)
        lines = [line for line in delta.summary(duplicate).splitlines() if line.startswith('Group ')]
        self.assertEqual(len(lines), 1)
        earlier, later, shared, unmatched_before, unmatched_after = group_information(lines[0])
        self.assertEqual((shared, unmatched_before, unmatched_after), (24, 1, 0))
        for displayed, omitted in [(earlier, 5), (later, 4)]:
            locators = re.match(r'[\d, ]+', displayed).group().strip()
            self.assertEqual([int(value.strip()) for value in locators.split(',')], list(range(2, 22)))
            self.assertIn('+' + str(omitted) + ' omitted', displayed)
            self.assertIn('--json', displayed)
        self.assertEqual(duplicate['groups'][0]['before_rows'], list(range(2, 27)))
        self.assertEqual(duplicate['groups'][0]['after_rows'], list(range(2, 26)))

    def test_cli_invalid_arguments_missing_files_and_malformed_csv_fail_with_fixed_redacted_errors(self):
        source = self.source([fictional_row()])
        malformed = self.folder / 'SYNTHETIC-PRIVATE-BAD.csv'
        for data in [b'\xff', b'"SYNTHETIC-PRIVATE-UNCLOSED', b'\x00', b'']:
            malformed.write_bytes(data)
            before = self.inventory()
            self.failure(self.run_cli(source, malformed, '--json'))
            self.assertEqual(self.inventory(), before)
        for args in [['--json'], [source, '--json'], [source, source, '--SYNTHETIC-PRIVATE-ARGUMENT', '--json'],
                     [source, self.folder / 'SYNTHETIC-PRIVATE-MISSING.csv', '--json']]:
            before = self.inventory()
            self.failure(self.run_cli(*args))
            self.assertEqual(self.inventory(), before)
        before = self.inventory()
        plain = self.run_cli(source, source, '--SYNTHETIC-PRIVATE-ARGUMENT')
        self.assertEqual(plain.returncode, 2)
        self.assertEqual(plain.stdout, '')
        self.assertTrue(plain.stderr.strip())
        for marker in [str(self.folder), 'SYNTHETIC-PRIVATE', 'Traceback']:
            self.assertNotIn(marker, plain.stderr)
        self.assertEqual(self.inventory(), before)

    def test_cli_refuses_symlinks_directories_and_fifo_without_blocking_or_changing_them(self):
        source = self.source([fictional_row()])
        directory = self.folder / 'SYNTHETIC-PRIVATE-DIRECTORY'
        directory.mkdir()
        symlink = self.folder / 'SYNTHETIC-PRIVATE-LINK.csv'
        symlink.symlink_to(source)
        parent_link = self.folder / 'SYNTHETIC-PRIVATE-PARENT'
        parent_link.symlink_to(directory, target_is_directory=True)
        nested = directory / 'SYNTHETIC-PRIVATE-NESTED.csv'
        nested.write_bytes(source.read_bytes())
        fifo = self.folder / 'SYNTHETIC-PRIVATE-FIFO'
        os.mkfifo(fifo)
        for invalid in [directory, symlink, parent_link / nested.name, fifo]:
            for args in [(invalid, source), (source, invalid)]:
                with self.subTest(kind=invalid.name):
                    before = self.inventory()
                    self.failure(self.run_cli(*args, '--json'))
                    self.assertEqual(self.inventory(), before)


if __name__ == '__main__':
    unittest.main()
