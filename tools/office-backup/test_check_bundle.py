"""Synthetic, local-only coverage for the read-only backup bundle checker."""
import contextlib
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = Path(__file__).with_name('check_bundle.py')
spec = importlib.util.spec_from_file_location('office_backup_check_bundle', MODULE_PATH)
checker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = checker
spec.loader.exec_module(checker)
BASELINE = ROOT / 'tools/office-preflight/manifest.json'
BASELINE_SHA = hashlib.sha256(BASELINE.read_bytes()).hexdigest()
DOCUMENT_ID = '10000000-0000-4000-8000-000000000001'
OTHER_ID = '10000000-0000-4000-8000-000000000002'
OBJECT_NAME = 'synthetic/source-page.bin'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def put(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_bytes(data)
    path.chmod(0o600)


@contextlib.contextmanager
def fixture(*, original=True, repeats=1, supplements=False):
    with tempfile.TemporaryDirectory(prefix='bcbc-backup-fixture-', dir='/private/tmp') as location:
        base = Path(location)
        base.chmod(0o700)
        bundle = base / 'bundle'
        bundle.mkdir(mode=0o700)
        manifest = bundle / 'manifest.json'
        data = {
            'format_version': 1,
            'baseline_manifest_sha256': BASELINE_SHA,
            'database': [], 'objects': [], 'originals': [],
            'documents': [], 'membership_sources': [],
        }
        kinds = ['roles', 'schema', 'data']
        if supplements:
            kinds += ['migration_history', 'managed_schema_changes']
        for kind in kinds:
            content = ('-- Synthetic ' + kind + ' artifact; never executed.\n').encode()
            relative = 'database/' + kind + '.sql'
            put(bundle / relative, content)
            data['database'].append({'kind': kind, 'path': relative, 'bytes': len(content), 'sha256': digest(content)})
        if original:
            content = b'Synthetic original source page.\n'
            put(bundle / 'originals/page.bin', content)
            data['objects'] = [{'name': OBJECT_NAME, 'size_bytes': len(content)}]
            data['originals'] = [{'name': OBJECT_NAME, 'path': 'originals/page.bin', 'bytes': len(content), 'sha256': digest(content)}]
            data['documents'] = [{'id': DOCUMENT_ID, 'storage_path': OBJECT_NAME, 'size_bytes': len(content)}]
            data['membership_sources'] = [DOCUMENT_ID] * repeats

        def save():
            put(manifest, (json.dumps(data, indent=2) + '\n').encode())

        save()
        yield {'base': base, 'bundle': bundle, 'manifest': manifest, 'data': data, 'save': save}


def inventory(base):
    result = {}
    for path in [base] + sorted(base.rglob('*')):
        metadata = path.lstat()
        name = str(path.relative_to(base))
        item = {'mode': stat.S_IMODE(metadata.st_mode), 'size': metadata.st_size,
                'mtime_ns': metadata.st_mtime_ns, 'nlink': metadata.st_nlink}
        if path.is_symlink():
            item['link'] = os.readlink(path)
        elif stat.S_ISREG(metadata.st_mode):
            item['sha256'] = digest(path.read_bytes())
        result[name] = item
    return result


class BundleChecks(unittest.TestCase):
    def check(self, f):
        return checker.check_bundle(f['bundle'], f['manifest'])

    def refused(self, f):
        before = inventory(f['base'])
        with self.assertRaises(checker.Refused) as rejected:
            self.check(f)
        self.assertRegex(str(rejected.exception), r'^[A-Z][A-Z0-9_]*$')
        self.assertEqual(inventory(f['base']), before, 'refusal must not alter the input bundle')

    def report(self, result, *, files=3, originals=1, documents=1, sources=1):
        self.assertEqual(result['status'], 'local_bundle_integrity_verified')
        self.assertEqual(result['database_files'], files)
        self.assertEqual(result['original_files'], originals)
        self.assertEqual(result['document_records'], documents)
        self.assertEqual(result['linked_sources'], sources)
        self.assertIs(result['database_restore_verified'], False)
        self.assertIs(result['off_device_verified'], False)
        rendered = json.dumps(result)
        for sensitive in [DOCUMENT_ID, OBJECT_NAME, 'database/roles.sql', 'originals/page.bin']:
            self.assertNotIn(sensitive, rendered)

    def test_valid_original_and_repeated_history_references_are_read_only(self):
        with fixture(repeats=2) as f:
            before = inventory(f['base'])
            result = self.check(f)
            self.report(result, sources=2)
            self.assertEqual(result['original_bytes'], f['data']['originals'][0]['bytes'])
            self.assertEqual(inventory(f['base']), before)

    def test_explicit_zero_originals_and_optional_database_supplements(self):
        for supplements in [False, True]:
            with self.subTest(supplements=supplements), fixture(original=False, supplements=supplements) as f:
                result = self.check(f)
                self.report(result, files=5 if supplements else 3, originals=0, documents=0, sources=0)
                self.assertEqual(result['original_bytes'], 0)

    def test_missing_or_changed_payloads_are_refused_without_repairs(self):
        for relative in ['originals/page.bin', 'database/data.sql']:
            for missing in [False, True]:
                with self.subTest(path=relative, missing=missing), fixture() as f:
                    path = f['bundle'] / relative
                    if missing:
                        path.unlink()
                    else:
                        content = path.read_bytes()
                        put(path, bytes([content[0] ^ 1]) + content[1:])
                    self.refused(f)

    def test_object_document_and_membership_source_closure_is_complete(self):
        changes = {
            'object_without_original': lambda d: d['objects'].append({'name': 'synthetic/unmatched.bin', 'size_bytes': 0}),
            'original_without_object': lambda d: d.update(objects=[]),
            'document_missing_object': lambda d: d['documents'][0].update(storage_path='synthetic/missing.bin'),
            'document_size_mismatch': lambda d: d['documents'][0].update(size_bytes=1),
            'object_size_mismatch': lambda d: d['objects'][0].update(size_bytes=1),
            'orphan_source': lambda d: d['membership_sources'].append(OTHER_ID),
            'source_without_document': lambda d: d.update(documents=[]),
        }
        for name, change in changes.items():
            with self.subTest(name=name), fixture() as f:
                change(f['data']); f['save'](); self.refused(f)

    def test_duplicate_kinds_names_ids_paths_and_json_keys_are_refused(self):
        for section in ['database', 'objects', 'originals', 'documents']:
            with self.subTest(section=section), fixture() as f:
                f['data'][section].append(copy.deepcopy(f['data'][section][0]))
                f['save'](); self.refused(f)
        with fixture() as f:
            f['data']['database'][1]['path'] = f['data']['database'][0]['path']
            f['save'](); self.refused(f)
        with fixture() as f:
            encoded = f['manifest'].read_text()
            put(f['manifest'], encoded.replace('"format_version": 1,', '"format_version": 1, "format_version": 1,', 1).encode())
            self.refused(f)

    def test_baseline_schema_types_and_declared_sizes_are_strict(self):
        changes = {
            'baseline': lambda d: d.update(baseline_manifest_sha256='0' * 64),
            'unknown_root_key': lambda d: d.update(extra='synthetic@example.invalid'),
            'unknown_artifact_key': lambda d: d['database'][0].update(extra=True),
            'unknown_kind': lambda d: d['database'][0].update(kind='arbitrary_sql'),
            'missing_required_kind': lambda d: d['database'].pop(),
            'bool_version': lambda d: d.update(format_version=True),
            'bool_size': lambda d: d['database'][0].update(bytes=True),
            'zero_database_size': lambda d: d['database'][0].update(bytes=0),
            'negative_original_size': lambda d: d['originals'][0].update(bytes=-1),
            'unbounded_size': lambda d: d['database'][0].update(bytes=2**63),
            'invalid_hash': lambda d: d['database'][0].update(sha256='Z' * 64),
            'malformed_uuid': lambda d: d['documents'][0].update(id='not-a-uuid'),
        }
        for name, change in changes.items():
            with self.subTest(name=name), fixture() as f:
                change(f['data']); f['save'](); self.refused(f)

    def test_unsafe_payload_paths_are_refused(self):
        for relative in ['.', '../outside.bin', '/private/tmp/outside.bin', 'database/../roles.sql', 'database/./roles.sql', 'database\\roles.sql', 'database/role\x00.sql']:
            with self.subTest(path=relative), fixture() as f:
                f['data']['database'][0]['path'] = relative
                f['save'](); self.refused(f)
        with fixture() as f:
            f['data']['originals'][0]['path'] = 'database/page.bin'
            f['save'](); self.refused(f)

    def test_symlinks_and_hardlinks_cannot_supply_payloads_or_manifests(self):
        for target in ['originals/page.bin', 'manifest.json']:
            for kind in ['symlink', 'hardlink']:
                with self.subTest(target=target, kind=kind), fixture() as f:
                    path = f['bundle'] / target
                    outside = f['base'] / 'outside-private.bin'
                    if kind == 'symlink':
                        path.rename(outside)
                        path.symlink_to(outside)
                    else:
                        os.link(path, outside)
                    self.refused(f)
        with fixture() as f:
            original_directory = f['bundle'] / 'originals'
            outside_directory = f['base'] / 'outside-originals'
            original_directory.rename(outside_directory)
            original_directory.symlink_to(outside_directory, target_is_directory=True)
            self.refused(f)

    def test_private_modes_and_exhaustive_file_inventory_are_required(self):
        for target, mode in [('', 0o755), ('manifest.json', 0o644), ('database/roles.sql', 0o640), ('originals/page.bin', 0o644)]:
            with self.subTest(target=target), fixture() as f:
                (f['bundle'] / target).chmod(mode)
                self.refused(f)
        with fixture() as f:
            put(f['bundle'] / 'unlisted-private.txt', b'Synthetic unlisted payload.\n')
            self.refused(f)

    def test_source_repository_paths_and_nonregular_payloads_are_refused(self):
        with fixture() as f:
            with self.assertRaises(checker.Refused):
                checker.check_bundle(ROOT, f['manifest'])
            with self.assertRaises(checker.Refused):
                checker.check_bundle(f['bundle'], BASELINE)
        with fixture() as f:
            payload = f['bundle'] / 'originals/page.bin'
            payload.unlink()
            payload.mkdir(mode=0o700)
            self.refused(f)

    def cli(self, f, *extra):
        return subprocess.run([sys.executable, '-B', str(MODULE_PATH), '--bundle', str(f['bundle']), '--manifest', str(f['manifest']), *extra],
                              text=True, capture_output=True, timeout=10,
                              env={'PATH': os.defpath, 'PYTHONDONTWRITEBYTECODE': '1'})

    def test_cli_success_prints_only_a_sanitized_report_without_writes(self):
        with fixture() as f:
            before = inventory(f['base'])
            result = self.cli(f)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stderr, '')
            self.report(json.loads(result.stdout))
            self.assertNotIn(str(f['base']), result.stdout)
            self.assertEqual(inventory(f['base']), before)

    def test_cli_failure_redacts_private_identifiers_and_does_not_mutate(self):
        with fixture() as f:
            private_marker = 'synthetic-secret-original@example.invalid'
            f['data']['membership_sources'] = [private_marker]
            f['save']()
            before = inventory(f['base'])
            result = self.cli(f)
            self.assertNotEqual(result.returncode, 0)
            combined = result.stdout + result.stderr
            for value in [private_marker, DOCUMENT_ID, OBJECT_NAME, str(f['base']), 'Traceback']:
                self.assertNotIn(value, combined)
            self.assertEqual(result.stderr, '')
            failure = json.loads(result.stdout)
            self.assertEqual(set(failure), {'status', 'error'})
            self.assertEqual(failure['status'], 'refused')
            self.assertRegex(failure['error'], r'^[A-Z][A-Z0-9_]*$')
            self.assertEqual(inventory(f['base']), before)
        with fixture() as f:
            private_marker = '--synthetic-private-argument@example.invalid'
            before = inventory(f['base'])
            result = self.cli(f, private_marker)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stderr, '')
            self.assertEqual(json.loads(result.stdout), {'status': 'refused', 'error': 'ARGUMENTS_INVALID'})
            self.assertNotIn(private_marker, result.stdout + result.stderr)
            self.assertEqual(inventory(f['base']), before)


if __name__ == '__main__':
    unittest.main()
