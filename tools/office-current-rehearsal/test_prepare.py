"""Offline preparation tests using disposable source and destination directories."""
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
MODULE_PATH = Path(__file__).with_name('prepare.py')
REPO = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('office_current_rehearsal_prepare', MODULE_PATH)
prepare = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = prepare
SPEC.loader.exec_module(prepare)
MANIFEST_PATH = 'tools/office-preflight/manifest.json'
CONFIG_PATH = 'tools/office-local-stack/config.toml'
MANIFEST_BYTES = (REPO / MANIFEST_PATH).read_bytes()
MANIFEST = json.loads(MANIFEST_BYTES)
CONFIG_BYTES = (REPO / CONFIG_PATH).read_bytes()
SQL_BYTES = {item['path']: (REPO / item['path']).read_bytes() for item in MANIFEST['sql_files']}


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_bytes(data)
    path.chmod(0o600)


def inventory(root):
    result = {}
    for path in sorted(root.rglob('*')):
        info = path.lstat()
        item = [stat.S_IMODE(info.st_mode), info.st_size, info.st_mtime_ns]
        if stat.S_ISLNK(info.st_mode):
            item.append(os.readlink(path))
        elif stat.S_ISREG(info.st_mode):
            item.append(sha256(path.read_bytes()))
        result[path.relative_to(root).as_posix()] = item
    return result


class CurrentRehearsalPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synthetic-current-rehearsal-', dir='/private/tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir(mode=0o700)
        self.destination = self.root / 'SYNTHETIC-PRIVATE-DESTINATION'
        write(self.source / MANIFEST_PATH, MANIFEST_BYTES)
        write(self.source / CONFIG_PATH, CONFIG_BYTES)
        for path, data in SQL_BYTES.items():
            write(self.source / path, data)
        self.patch = patch.object(prepare, 'REPO', self.source)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def run_cli(self, *arguments):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = prepare.main([str(argument) for argument in arguments])
        return status, stdout.getvalue(), stderr.getvalue()

    def refusal(self, target=None):
        before = inventory(self.root)
        with self.assertRaises(prepare.PrepareError) as failure:
            prepare.prepare(target if target is not None else self.destination)
        self.assertRegex(str(failure.exception), r'^[A-Z][A-Z0-9_]*$')
        self.assertNotIn('SYNTHETIC', str(failure.exception))
        self.assertEqual(inventory(self.root), before, 'validation failure must not create a partial target or alter source files')

    def test_new_packet_contains_only_exact_active_migrations_config_and_sanitized_preparation_record(self):
        write(self.source / 'tools/public-intake/migrations/20990101010101_optional.sql', b'-- Synthetic excluded optional migration.\n')
        write(self.source / 'tools/office-account-guard/migrations/20990101010102_optional.sql', b'-- Synthetic excluded account guard.\n')
        source_before = inventory(self.source)
        report = prepare.prepare(self.destination)
        expected_payloads = {'supabase/config.toml', *SQL_BYTES}
        files = {path.relative_to(self.destination).as_posix() for path in self.destination.rglob('*') if path.is_file()}
        self.assertEqual(files, expected_payloads | {'preparation.json'})
        self.assertEqual(report['format_version'], 1)
        self.assertEqual(report['status'], 'prepared_not_started')
        self.assertEqual(report['project_id'], 'bcbc-office-current-rehearsal-v2')
        self.assertEqual(report['ports'], {'api': 55521, 'db': 55522, 'shadow': 55520, 'smtp': 55524, 'browser': 8830})
        self.assertEqual(report['migration_count'], 7)
        self.assertIs(report['started'], False)
        self.assertIs(report['hosted_calls'], False)
        self.assertEqual(report['source_config_sha256'], sha256(CONFIG_BYTES))
        self.assertEqual(report['config_sha256'], sha256((self.destination / 'supabase/config.toml').read_bytes()))
        self.assertEqual({row['path'] for row in report['files']}, expected_payloads)
        self.assertEqual(len(report['files']), 8)
        for row in report['files']:
            data = (self.destination / row['path']).read_bytes()
            self.assertEqual(row['sha256'], sha256(data))
            self.assertEqual(row['bytes'], len(data))
        for path, expected in SQL_BYTES.items():
            self.assertEqual((self.destination / path).read_bytes(), expected)
        self.assertEqual(json.loads((self.destination / 'preparation.json').read_bytes()), report)
        for private in [str(self.source), str(self.destination), 'SYNTHETIC-PRIVATE']:
            self.assertNotIn(private, json.dumps(report))
        self.assertEqual(inventory(self.source), source_before)

    def test_config_isolates_project_ports_urls_and_global_signup_while_retaining_staff_email_provider(self):
        prepare.prepare(self.destination)
        expected = copy.deepcopy(tomllib.loads(CONFIG_BYTES.decode('utf-8')))
        expected['project_id'] = 'bcbc-office-current-rehearsal-v2'
        for section, key, value in [('api', 'port', 55521), ('db', 'port', 55522), ('db', 'shadow_port', 55520),
                                    ('studio', 'port', 55523), ('local_smtp', 'port', 55524), ('analytics', 'port', 55527)]:
            expected[section][key] = value
        expected['db']['pooler']['port'] = 55529
        expected['auth']['site_url'] = 'http://127.0.0.1:8830'
        expected['auth']['additional_redirect_urls'] = [url.replace(':8810/', ':8830/') for url in expected['auth']['additional_redirect_urls']]
        expected['auth']['enable_signup'] = False
        actual = tomllib.loads((self.destination / 'supabase/config.toml').read_text())
        self.assertEqual(actual, expected, 'every setting outside the approved isolation changes must remain identical')
        self.assertFalse(actual['auth']['enable_signup'])
        self.assertTrue(actual['auth']['email']['enable_signup'], 'staff email sign-in must not be disabled with public self-signup')
        self.assertFalse(actual['db']['seed']['enabled'])
        self.assertFalse(actual['auth']['enable_anonymous_sign_ins'])
        self.assertFalse(actual['auth']['sms']['enable_signup'])
        self.assertNotIn('smtp', actual['auth']['email'], 'no production email service is configured')

    def test_all_created_directories_and_files_are_private_even_with_permissive_umask(self):
        previous = os.umask(0)
        try:
            prepare.prepare(self.destination)
        finally:
            os.umask(previous)
        for path in [self.destination, *self.destination.rglob('*')]:
            info = path.lstat()
            self.assertFalse(stat.S_ISLNK(info.st_mode))
            self.assertEqual(info.st_uid, os.getuid())
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o700 if path.is_dir() else 0o600)

    def test_existing_directory_file_and_dangling_symlink_targets_are_never_overwritten(self):
        directory = self.root / 'existing-directory'
        directory.mkdir(mode=0o700)
        write(directory / 'SYNTHETIC-SENTINEL', b'Synthetic existing work.\n')
        file = self.root / 'existing-file'
        write(file, b'Synthetic existing file.\n')
        link = self.root / 'dangling-target'
        link.symlink_to(self.root / 'never-create-this')
        for target in [directory, file, link]:
            with self.subTest(kind=target.name):
                self.refusal(target)
        prepare.prepare(self.destination)
        self.refusal(self.destination)

    def test_symlink_parent_traversal_relative_missing_parent_and_source_nesting_are_refused(self):
        physical = self.root / 'physical'
        physical.mkdir(mode=0o700)
        linked = self.root / 'linked-parent'
        linked.symlink_to(physical, target_is_directory=True)
        for target in [linked / 'new', physical / '..' / 'new', Path('SYNTHETIC-relative-destination'),
                       self.root / 'missing-parent' / 'new', self.source / 'new', self.source.parent]:
            with self.subTest(target=str(target)):
                self.refusal(target)

    def test_git_directory_worktree_marker_and_bare_repository_ancestors_are_refused(self):
        for kind in ['directory', 'worktree', 'bare']:
            root = self.root / ('synthetic-' + kind)
            root.mkdir(mode=0o700)
            if kind == 'directory':
                (root / '.git').mkdir(mode=0o700)
            elif kind == 'worktree':
                write(root / '.git', b'gitdir: SYNTHETIC-PRIVATE-MARKER\n')
            else:
                write(root / 'HEAD', b'ref: refs/heads/synthetic\n')
                (root / 'objects').mkdir(mode=0o700)
                (root / 'refs').mkdir(mode=0o700)
            with self.subTest(kind=kind):
                self.refusal(root / 'new')

    def test_manifest_path_hash_order_dependencies_and_count_cannot_be_changed(self):
        changes = [lambda data: data['sql_files'][0].update(path='../SYNTHETIC-PRIVATE.sql'),
                   lambda data: data['sql_files'][0].update(sha256='0' * 64),
                   lambda data: data['sql_files'].reverse(),
                   lambda data: data['sql_files'][1].update(depends_on=[]),
                   lambda data: data['sql_files'].pop()]
        for change in changes:
            data = copy.deepcopy(MANIFEST)
            change(data)
            write(self.source / MANIFEST_PATH, json.dumps(data).encode())
            self.refusal()
        write(self.source / MANIFEST_PATH, b'{SYNTHETIC-PRIVATE-BROKEN-JSON')
        self.refusal()

    def test_changed_sql_cannot_be_accepted_by_forging_its_manifest_digest(self):
        first = MANIFEST['sql_files'][0]['path']
        altered = SQL_BYTES[first] + b'\n-- Synthetic drift.\n'
        write(self.source / first, altered)
        self.refusal()
        forged = copy.deepcopy(MANIFEST)
        forged['sql_files'][0]['sha256'] = sha256(altered)
        write(self.source / MANIFEST_PATH, json.dumps(forged).encode())
        self.refusal()

    def test_missing_or_added_active_migrations_fail_before_any_target_is_created(self):
        first = MANIFEST['sql_files'][0]['path']
        (self.source / first).unlink()
        self.refusal()
        write(self.source / first, SQL_BYTES[first])
        write(self.source / 'supabase/migrations/20990101010101_unreviewed.sql', b'-- Synthetic unreviewed migration.\n')
        self.refusal()

    def test_source_config_drift_and_hosted_project_link_marker_are_refused(self):
        for before, after in [(b'max_rows = 1000', b'max_rows = 5000'),
                              (b'http://127.0.0.1:8810', b'https://SYNTHETIC-PRIVATE.example.invalid'),
                              (b'auto_expose_new_tables = false', b'auto_expose_new_tables = true')]:
            self.assertIn(before, CONFIG_BYTES)
            write(self.source / CONFIG_PATH, CONFIG_BYTES.replace(before, after))
            self.refusal()
        write(self.source / CONFIG_PATH, CONFIG_BYTES)
        write(self.source / 'supabase/.temp/project-ref', b'SYNTHETIC-PRIVATE-HOSTED-REF')
        self.refusal()

    def test_source_email_provider_disable_is_unintended_configuration_and_is_refused(self):
        original = CONFIG_BYTES.decode('utf-8')
        prefix, email = original.split('[auth.email]', 1)
        before, after = 'enable_signup = true', 'enable_signup = false'
        self.assertIn(before, email)
        disabled = prefix + '[auth.email]' + email.replace(before, after, 1)
        parsed = tomllib.loads(disabled)
        self.assertTrue(parsed['auth']['enable_signup'], 'fixture changes only the email-provider switch')
        self.assertFalse(parsed['auth']['email']['enable_signup'])
        write(self.source / CONFIG_PATH, disabled.encode('utf-8'))
        self.refusal()

    def test_json_and_human_cli_reports_never_echo_absolute_paths_or_claim_services_started(self):
        source_before = inventory(self.source)
        status, stdout, stderr = self.run_cli(self.destination, '--json')
        self.assertEqual(status, 0)
        self.assertEqual(stderr, '')
        report = json.loads(stdout)
        self.assertEqual(report['status'], 'prepared_not_started')
        self.assertIs(report['started'], False)
        self.assertIs(report['hosted_calls'], False)
        second = self.root / 'SYNTHETIC-PRIVATE-SECOND'
        code, text, error = self.run_cli(second)
        self.assertEqual(code, 0)
        self.assertEqual(error, '')
        for private in [str(self.root), 'SYNTHETIC-PRIVATE']:
            self.assertNotIn(private, stdout + stderr + text + error)
        self.assertEqual(inventory(self.source), source_before)

    def test_invalid_cli_arguments_and_destination_failures_are_fixed_redacted_and_do_not_write(self):
        for arguments in [['--json'], [self.destination, '--SYNTHETIC-PRIVATE-UNKNOWN', '--json'],
                          [self.source / 'new', '--json'], [self.root / 'missing' / 'new', '--json']]:
            with self.subTest(arguments=arguments):
                before = inventory(self.root)
                status, stdout, stderr = self.run_cli(*arguments)
                self.assertEqual(status, 2)
                parsed = json.loads(stdout)
                self.assertRegex(parsed['error'], r'^[A-Z][A-Z0-9_]*$')
                self.assertEqual(stderr, '')
                self.assertNotIn('SYNTHETIC-PRIVATE', stdout + stderr)
                self.assertNotIn(str(self.root), stdout + stderr)
                self.assertEqual(inventory(self.root), before)
        before = inventory(self.root)
        status, stdout, stderr = self.run_cli(self.destination, '--SYNTHETIC-PRIVATE-UNKNOWN')
        self.assertEqual(status, 2)
        for private in ['SYNTHETIC-PRIVATE', str(self.root), 'Traceback']:
            self.assertNotIn(private, stdout + stderr)
        self.assertEqual(inventory(self.root), before)


if __name__ == '__main__':
    unittest.main()
