"""Independent offline tests; all writable inputs are disposable synthetic copies."""
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
spec = importlib.util.spec_from_file_location('tested_recovery_source_preparer', Path(__file__).with_name('prepare_source.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
MANIFEST_PATH = 'tools/office-preflight/manifest.json'
CONFIG_PATH = 'tools/office-local-stack/config.toml'
MANIFEST_BYTES = (REPO / MANIFEST_PATH).read_bytes()
MANIFEST = json.loads(MANIFEST_BYTES)
CONFIG = (REPO / CONFIG_PATH).read_bytes()
SQL = {entry['path']: (REPO / entry['path']).read_bytes() for entry in MANIFEST['sql_files']}
EXPECTED_CONFIG = '97684b65c3a345d0c47d0a6b5942428aeb0d9f3f89b6657f0bdee8b9c5f2a662'


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


class PrepareSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synthetic-recovery-preparation-', dir='/private/tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'source'
        self.destination = self.root / 'PRIVATE-FIXTURE' / 'stack'
        write(self.repo / CONFIG_PATH, CONFIG)
        write(self.repo / MANIFEST_PATH, MANIFEST_BYTES)
        for name, data in SQL.items():
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

    def test_exact_seven_payloads_config_private_modes_and_source_immutability(self):
        write(self.repo / 'tools/public-intake/migrations/20990101000000_optional.sql', b'-- excluded synthetic SQL\n')
        before = inventory(self.repo)
        base_state = (p.p.REPO, p.p.PROJECT, p.p.PORTS, p.p.payloads)
        old_umask = os.umask(0)
        try:
            report = p.prepare()
        finally:
            os.umask(old_umask)
        self.assertEqual((p.p.REPO, p.p.PROJECT, p.p.PORTS, p.p.payloads), base_state)
        paths = {path.relative_to(self.destination).as_posix() for path in self.destination.rglob('*') if path.is_file()}
        self.assertEqual(paths, {'supabase/config.toml', 'preparation.json', *SQL})
        self.assertEqual(report['project_id'], 'bcbc-office-recovery-source-v1')
        self.assertEqual(report['ports'], {'api': 55621, 'db': 55622, 'shadow': 55620, 'smtp': 55624, 'browser': 8831})
        self.assertEqual(report['migration_count'], 7)
        self.assertEqual(len(report['files']), 8)
        self.assertEqual(report['status'], 'prepared_not_started')
        self.assertIs(report['started'], False)
        self.assertIs(report['hosted_calls'], False)
        self.assertEqual(report['config_sha256'], EXPECTED_CONFIG)
        for entry in report['files']:
            content = (self.destination / entry['path']).read_bytes()
            self.assertEqual((sha(content), len(content)), (entry['sha256'], entry['bytes']))
        for name, data in SQL.items():
            self.assertEqual((self.destination / name).read_bytes(), data)
        for path in [self.destination.parent, self.destination, *self.destination.rglob('*')]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)
        self.assertEqual(json.loads((self.destination / 'preparation.json').read_bytes()), report)
        self.assertNotIn(str(self.root), json.dumps(report))
        self.assertEqual(inventory(self.repo), before)
        self.assertEqual(p.verify_prepared_source(), {'config_sha256': EXPECTED_CONFIG, 'migration_count': 7})

    def test_entire_config_changes_only_isolation_and_global_signup(self):
        result = tomllib.loads(p.source_config(CONFIG).decode())
        expected = copy.deepcopy(tomllib.loads(CONFIG.decode()))
        expected['project_id'] = 'bcbc-office-recovery-source-v1'
        for section, key, value in [('api', 'port', 55621), ('db', 'port', 55622), ('db', 'shadow_port', 55620), ('studio', 'port', 55623), ('local_smtp', 'port', 55624), ('analytics', 'port', 55627)]:
            expected[section][key] = value
        expected['db']['pooler']['port'] = 55629
        expected['auth']['site_url'] = 'http://127.0.0.1:8831'
        expected['auth']['additional_redirect_urls'] = [url.replace(':8810/', ':8831/') for url in expected['auth']['additional_redirect_urls']]
        expected['auth']['enable_signup'] = False
        self.assertEqual(result, expected)
        self.assertTrue(result['auth']['email']['enable_signup'])
        self.assertFalse(result['db']['seed']['enabled'])
        self.assertFalse(result['auth']['enable_anonymous_sign_ins'])

    def test_existing_private_parent_fixed_destination_and_physical_path_guards(self):
        for target in [self.root / 'OTHER' / 'stack', Path('relative'), self.destination.parent / '..' / 'stack', self.repo / 'stack']:
            with self.subTest(target=str(target)):
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
        (self.root / '.git').mkdir()
        self.refuse()

    def test_hash_manifest_dependency_and_inventory_laundering_is_refused_before_write(self):
        changes = [lambda value: value['sql_files'].reverse(), lambda value: value['sql_files'].pop(),
                   lambda value: value['sql_files'][1].update(depends_on=[]),
                   lambda value: value['sql_files'][0].update(path='../PRIVATE.sql'),
                   lambda value: value['sql_files'][0].update(sha256='0' * 64)]
        for change in changes:
            data = copy.deepcopy(MANIFEST)
            change(data)
            write(self.repo / MANIFEST_PATH, json.dumps(data).encode())
            self.refuse()
        altered_path = MANIFEST['sql_files'][0]['path']
        altered = SQL[altered_path] + b'-- synthetic drift\n'
        forged = copy.deepcopy(MANIFEST)
        forged['sql_files'][0]['sha256'] = sha(altered)
        write(self.repo / altered_path, altered)
        write(self.repo / MANIFEST_PATH, json.dumps(forged).encode())
        self.refuse()
        write(self.repo / altered_path, SQL[altered_path])
        write(self.repo / MANIFEST_PATH, MANIFEST_BYTES)
        write(self.repo / 'supabase/migrations/20990101000000_extra.sql', b'-- synthetic extra\n')
        self.refuse()

    def test_config_drift_and_linked_project_cannot_create_a_source(self):
        for old, new in [(b'max_rows = 1000', b'max_rows = 5000'),
                         (b'http://127.0.0.1:8810', b'https://fictional.example.invalid')]:
            write(self.repo / CONFIG_PATH, CONFIG.replace(old, new))
            self.refuse()
        write(self.repo / CONFIG_PATH, CONFIG)
        write(self.repo / 'supabase/.temp/project-ref', b'PRIVATE-HOSTED-MARKER')
        self.refuse()

    def test_prepared_source_verification_refuses_changed_mode_bytes_hardlinks_and_linking(self):
        p.prepare()
        path = self.destination / next(iter(SQL))
        original = path.read_bytes()
        path.chmod(0o644)
        with self.assertRaises(p.PrepareError):
            p.verify_prepared_source()
        path.chmod(0o600)
        path.write_bytes(original + b'-- changed\n')
        with self.assertRaises(p.PrepareError):
            p.verify_prepared_source()
        path.write_bytes(original)
        twin = self.root / 'hardlink'
        os.link(path, twin)
        with self.assertRaises(p.PrepareError):
            p.verify_prepared_source()
        twin.unlink()
        write(self.destination / 'supabase/.temp/project-ref', b'PRIVATE-HOSTED-MARKER')
        with self.assertRaises(p.PrepareError):
            p.verify_prepared_source()

    def test_cli_exact_arguments_redacted_errors_and_no_runtime_claim(self):
        for args in [[], ['--prepare', '--apply=PRIVATE'], ['--json', '--prepare'], [str(self.destination)]]:
            before = inventory(self.root)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = p.main(args)
            report = json.loads(output.getvalue())
            self.assertEqual(code, 2)
            self.assertEqual(report, {'status': 'refused', 'error': 'EXACT_USAGE_REQUIRED', 'started': False, 'hosted_calls': False})
            self.assertNotIn('PRIVATE', output.getvalue())
            self.assertEqual(inventory(self.root), before)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(p.main(['--prepare', '--json']), 0)
        self.assertEqual(json.loads(output.getvalue())['status'], 'prepared_not_started')
        self.assertNotIn(str(self.root), output.getvalue())


if __name__ == '__main__':
    unittest.main()
