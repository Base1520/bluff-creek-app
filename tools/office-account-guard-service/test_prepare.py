"""Offline preparation checks; writable fixtures stay in disposable temporary folders."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('tested_account_guard_preparer', Path(__file__).with_name('prepare.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
CONFIG_PATH = 'tools/office-local-stack/config.toml'
MANIFEST_PATH = 'tools/office-preflight/manifest.json'
CONFIG = (REPO / CONFIG_PATH).read_bytes()
MANIFEST_BYTES = (REPO / MANIFEST_PATH).read_bytes()
MANIFEST = json.loads(MANIFEST_BYTES)
SQL = {entry['path']: (REPO / entry['path']).read_bytes() for entry in MANIFEST['sql_files']}
GUARD = (REPO / p.GUARD_PATH).read_bytes()
GUARD_MANIFEST = (REPO / p.GUARD_MANIFEST_PATH).read_bytes()
EXPECTED_CONFIG = '1cd09cbbe5787004dca031329c71e8de5242b54c89c586cf904623b5b2521a73'
GUARD_COPY = 'supabase/migrations/20260909024020_require_eligible_staff_auth_account.sql'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_bytes(data)
    path.chmod(0o600)


def inventory(root):
    result = {}
    for path in sorted(root.rglob('*')):
        info = path.lstat()
        result[path.relative_to(root).as_posix()] = (
            stat.S_IMODE(info.st_mode), info.st_size,
            os.readlink(path) if path.is_symlink() else sha(path.read_bytes()) if path.is_file() else None)
    return result


class GuardPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synthetic-account-guard-preparation-', dir='/private/tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'source'
        self.destination = self.root / 'PRIVATE-FIXTURE' / 'stack'
        for name, data in {CONFIG_PATH: CONFIG, MANIFEST_PATH: MANIFEST_BYTES, p.GUARD_PATH: GUARD,
                           p.GUARD_MANIFEST_PATH: GUARD_MANIFEST, **SQL}.items():
            write(self.repo / name, data)
        for attribute, value in [('REPO', self.repo), ('DESTINATION', self.destination)]:
            replacement = patch.object(p, attribute, value)
            replacement.start()
            self.addCleanup(replacement.stop)

    def refuse(self, destination=None):
        before = inventory(self.root)
        with self.assertRaises(p.PrepareError) as error:
            p.prepare(destination)
        self.assertRegex(str(error.exception), r'^[A-Z_]+$')
        self.assertEqual(inventory(self.root), before)

    def test_exact_eight_migrations_manifest_copy_private_modes_and_no_source_mutation(self):
        write(self.repo / 'tools/public-intake/migrations/20990101000000_optional.sql', b'-- excluded\n')
        before = inventory(self.repo)
        base_state = (p.p.REPO, p.p.PROJECT, p.p.PORTS, p.p.payloads, p.p.current_config)
        old_umask = os.umask(0)
        try:
            report = p.prepare()
        finally:
            os.umask(old_umask)
        self.assertEqual((p.p.REPO, p.p.PROJECT, p.p.PORTS, p.p.payloads, p.p.current_config), base_state)
        paths = {path.relative_to(self.destination).as_posix() for path in self.destination.rglob('*') if path.is_file()}
        self.assertEqual(paths, {'supabase/config.toml', 'preparation.json', 'account-guard-manifest.json', GUARD_COPY, *SQL})
        self.assertEqual(report['project_id'], 'bcbc-office-account-guard-v1')
        self.assertEqual(report['ports'], {'api': 55821, 'db': 55822, 'shadow': 55820, 'smtp': 55824, 'browser': 8833})
        self.assertEqual(p.ORIGIN, 'http://127.0.0.1:55821')
        self.assertEqual((report['migration_count'], report['payload_file_count'], report['output_file_count']), (8, 10, 11))
        self.assertEqual(len(report['files']), 10)
        self.assertEqual(report['migration_versions'], [name[:14] for name in sorted([Path(name).name for name in SQL] + [Path(GUARD_COPY).name])])
        self.assertEqual(report['status'], 'prepared_not_started')
        self.assertIs(report['started'], False)
        self.assertIs(report['hosted_calls'], False)
        self.assertEqual(report['config_sha256'], EXPECTED_CONFIG)
        for entry in report['files']:
            content = (self.destination / entry['path']).read_bytes()
            self.assertEqual((sha(content), len(content)), (entry['sha256'], entry['bytes']))
        for name, data in {**SQL, GUARD_COPY: GUARD, 'account-guard-manifest.json': GUARD_MANIFEST}.items():
            self.assertEqual((self.destination / name).read_bytes(), data)
        for path in [self.destination.parent, self.destination, *self.destination.rglob('*')]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)
        self.assertEqual(json.loads((self.destination / 'preparation.json').read_bytes()), report)
        self.assertNotIn(str(self.root), json.dumps(report))
        self.assertEqual(inventory(self.repo), before)
        self.assertEqual(p.verify_prepared_source(), {'config_sha256': EXPECTED_CONFIG, 'migration_count': 8,
                                                     'guard_manifest_sha256': sha(GUARD_MANIFEST)})

    def test_entire_config_only_changes_isolation_and_global_signup(self):
        expected = copy.deepcopy(tomllib.loads(CONFIG.decode()))
        expected['project_id'] = 'bcbc-office-account-guard-v1'
        for section, key, value in [('api', 'port', 55821), ('db', 'port', 55822), ('db', 'shadow_port', 55820),
                                    ('studio', 'port', 55823), ('local_smtp', 'port', 55824), ('analytics', 'port', 55827)]:
            expected[section][key] = value
        expected['db']['pooler']['port'] = 55829
        expected['auth']['site_url'] = 'http://127.0.0.1:8833'
        expected['auth']['additional_redirect_urls'] = [url.replace(':8810/', ':8833/') for url in expected['auth']['additional_redirect_urls']]
        expected['auth']['enable_signup'] = False
        result = tomllib.loads(p.source_config(CONFIG).decode())
        self.assertEqual(result, expected)
        self.assertTrue(result['auth']['email']['enable_signup'])
        self.assertFalse(result['auth']['enable_anonymous_sign_ins'])
        self.assertFalse(result['db']['seed']['enabled'])

    def test_fixed_fresh_physical_destination_outside_repositories(self):
        for target in [self.root / 'OTHER' / 'stack', Path('relative'), self.destination.parent / '..' / 'stack', self.repo / 'stack']:
            with self.subTest(kind='wrong destination'):
                self.refuse(target)
        self.destination.parent.mkdir(mode=0o700)
        self.refuse()
        self.destination.parent.rmdir()
        self.destination.parent.symlink_to(self.root / 'absent', target_is_directory=True)
        self.refuse()
        self.destination.parent.unlink()
        physical = self.root / 'physical'
        physical.mkdir()
        link = self.root / 'linked'
        link.symlink_to(physical, target_is_directory=True)
        with patch.object(p, 'DESTINATION', link / 'private' / 'stack'):
            self.refuse()
        with patch.object(p, 'DESTINATION', self.repo / 'private' / 'stack'):
            self.refuse()
        (self.root / '.git').mkdir()
        self.refuse()

    def test_active_manifest_and_sql_digest_laundering_refused_before_creation(self):
        for mutate in [lambda data: data['sql_files'].reverse(), lambda data: data['sql_files'].pop(),
                       lambda data: data['sql_files'][1].update(depends_on=[]),
                       lambda data: data['sql_files'][0].update(path='../PRIVATE.sql')]:
            forged = copy.deepcopy(MANIFEST)
            mutate(forged)
            write(self.repo / MANIFEST_PATH, json.dumps(forged).encode())
            self.refuse()
        name = next(iter(SQL))
        altered = SQL[name] + b'-- synthetic drift\n'
        forged = copy.deepcopy(MANIFEST)
        forged['sql_files'][0]['sha256'] = sha(altered)
        write(self.repo / name, altered)
        write(self.repo / MANIFEST_PATH, json.dumps(forged).encode())
        self.refuse()

    def test_optional_sql_manifest_and_baseline_binding_are_pinned(self):
        write(self.repo / p.GUARD_PATH, GUARD + b'-- changed\n')
        self.refuse()
        forged = json.loads(GUARD_MANIFEST)
        forged['migration']['sha256'] = sha(GUARD + b'-- changed\n')
        write(self.repo / p.GUARD_MANIFEST_PATH, json.dumps(forged).encode())
        self.refuse()
        write(self.repo / p.GUARD_PATH, GUARD)
        for mutate in [lambda data: data.update(baseline_manifest_sha256='0' * 64),
                       lambda data: data['migration'].update(path='../PRIVATE.sql'),
                       lambda data: data.update(hosted_applied=True)]:
            forged = json.loads(GUARD_MANIFEST)
            mutate(forged)
            write(self.repo / p.GUARD_MANIFEST_PATH, json.dumps(forged).encode())
            self.refuse()
        write(self.repo / p.GUARD_MANIFEST_PATH, GUARD_MANIFEST)
        # Even semantically equivalent active-manifest bytes break the optional guard's baseline binding.
        write(self.repo / MANIFEST_PATH, MANIFEST_BYTES + b'\n')
        self.refuse()

    def test_source_inventory_config_links_and_symlink_input_refused(self):
        for relative in ['supabase/migrations/20990101000000_extra.sql',
                         'tools/office-account-guard/migrations/20990101000000_extra.sql']:
            path = self.repo / relative
            write(path, b'-- extra\n')
            self.refuse()
            path.unlink()
        for before, after in [(b'max_rows = 1000', b'max_rows = 5000'),
                              (b'http://127.0.0.1:8810', b'https://fictional.example.invalid'),
                              (b'[auth.email]\n', b'[auth.email]\nenable_signup = false\n')]:
            write(self.repo / CONFIG_PATH, CONFIG.replace(before, after))
            self.refuse()
        write(self.repo / CONFIG_PATH, CONFIG)
        link = self.repo / 'supabase/.temp/project-ref'
        write(link, b'PRIVATE-HOSTED-MARKER')
        self.refuse()
        link.unlink()
        guard = self.repo / p.GUARD_PATH
        guard.unlink()
        original = self.root / 'guard-copy.sql'
        write(original, GUARD)
        guard.symlink_to(original)
        self.refuse()

    def test_existing_preparation_cannot_be_overwritten_or_reused(self):
        p.prepare()
        before = inventory(self.root)
        self.refuse()
        self.assertEqual(inventory(self.root), before)

    def test_verification_refuses_changed_payloads_modes_hardlinks_and_marker(self):
        p.prepare()
        for relative in [GUARD_COPY, 'account-guard-manifest.json', 'preparation.json', 'supabase/config.toml']:
            path = self.destination / relative
            original = path.read_bytes()
            path.write_bytes(original + b' ')
            with self.assertRaises(p.PrepareError):
                p.verify_prepared_source()
            path.write_bytes(original)
        target = self.destination / GUARD_COPY
        target.chmod(0o644)
        with self.assertRaises(p.PrepareError):
            p.verify_prepared_source()
        target.chmod(0o600)
        twin = self.root / 'hardlink'
        os.link(target, twin)
        with self.assertRaises(p.PrepareError):
            p.verify_prepared_source()
        twin.unlink()
        self.destination.chmod(0o755)
        with self.assertRaises(p.PrepareError):
            p.verify_prepared_source()
        self.destination.chmod(0o700)
        write(self.destination / 'supabase/.temp/project-ref', b'PRIVATE-HOSTED-MARKER')
        with self.assertRaises(p.PrepareError):
            p.verify_prepared_source()

    def test_verification_allows_local_cli_metadata_but_exactly_eight_migration_entries(self):
        p.prepare()
        write(self.destination / 'supabase/.temp/cli-latest', b'2.117.0')
        self.assertEqual(p.verify_prepared_source()['migration_count'], 8)
        extra = self.destination / 'supabase/migrations/not-a-migration.txt'
        write(extra, b'Unexpected extra')
        with self.assertRaises(p.PrepareError):
            p.verify_prepared_source()

    def test_partial_creation_is_preserved_and_failure_diagnostic_is_redacted(self):
        output = io.StringIO()
        with patch.object(p.p, 'write_exclusive', side_effect=OSError('PRIVATE-DETAIL')), contextlib.redirect_stdout(output):
            self.assertEqual(p.main(['--prepare']), 2)
        self.assertTrue(self.destination.is_dir())
        self.assertEqual(json.loads(output.getvalue()), {'status': 'refused', 'error': 'SOURCE_PREPARATION_FAILED',
                                                        'started': False, 'hosted_calls': False})
        self.assertNotIn('PRIVATE-DETAIL', output.getvalue())
        self.refuse()

    def test_cli_only_prepares_exact_fixture_and_redacts_invalid_arguments(self):
        for args in [[], ['--prepare', '--apply=PRIVATE'], ['--json', '--prepare'], [str(self.destination)]]:
            before = inventory(self.root)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = p.main(args)
            self.assertEqual(code, 2)
            self.assertEqual(json.loads(output.getvalue()), {'status': 'refused', 'error': 'EXACT_USAGE_REQUIRED',
                                                            'started': False, 'hosted_calls': False})
            self.assertNotIn('PRIVATE', output.getvalue())
            self.assertEqual(inventory(self.root), before)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(p.main(['--prepare', '--json']), 0)
        self.assertEqual(json.loads(output.getvalue())['migration_count'], 8)
        self.assertNotIn(str(self.root), output.getvalue())


if __name__ == '__main__':
    unittest.main()
