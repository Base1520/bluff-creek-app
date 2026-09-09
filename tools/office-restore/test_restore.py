"""Pure guards only: no Docker, network, services, volumes or backup operations."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('office_restore', Path(__file__).with_name('restore.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

SYNTHETIC_CONFIG = b'''project_id = "bcbc-office-rehearsal"
[api]
port = 55321
auto_expose_new_tables = false
[db]
port = 55322
major_version = 17
[db.seed]
enabled = false
[local_smtp]
port = 55324
[auth]
site_url = "http://127.0.0.1:8810"
[auth.email]
enable_signup = true
[auth.sms]
enable_signup = false
[auth.sms.twilio]
enabled = false
'''


def archive(path, members=None):
    with tarfile.open(path, 'w') as out:
        root = tarfile.TarInfo('.')
        root.type, root.mode, root.uid, root.gid = tarfile.DIRTYPE, 0o700, 100, 101
        out.addfile(root)
        for member, content in members or []:
            out.addfile(member, io.BytesIO(content) if member.isreg() else None)


def payload(name='stub/photo/version', data=b'fictional image bytes'):
    member = tarfile.TarInfo(name)
    member.mode, member.uid, member.gid, member.size = 0o600, 100, 101, len(data)
    return member, data


def rows():
    result = {name: [] for name in r.TABLES}
    result['auth.users'] = [{'email': f'fictional{i}@restore.invalid', 'banned_until': '2126-01-01T00:00:00+00:00'} for i in range(9)]
    result['supabase_migrations.schema_migrations'] = [{'version': v} for v in r.MIGRATIONS]
    result['public.documents'] = [{'id': 'fictional-document', 'uploaded_by': 'fictional-owner', 'storage_path': 'fictional-owner/history/page.png'}]
    result['storage.objects'] = [{'bucket_id': 'church-documents', 'name': 'fictional-owner/history/page.png'}]
    result['storage.buckets'] = [{'id': 'church-documents', 'public': False}]
    result['public.membership_history'] = [{'source_document_id': 'fictional-document'}]
    return result


class Guards(unittest.TestCase):
    def test_source_can_never_be_writable_helper_mount(self):
        with self.assertRaisesRegex(r.Refused, 'SOURCE_WRITABLE'):
            r.helper_args('db', r.SOURCE, write=True)
        args = r.helper_args('db', r.SOURCE)
        self.assertIn('--network', args)
        self.assertIn('none', args)
        self.assertIn('type=volume,src=supabase_db_bcbc-office-rehearsal,dst=/volume,volume-nocopy,readonly', args)
        self.assertIn('--pull=never', args)
        self.assertIn('sha256:' + r.IMAGES['db'][1], args)

    def test_arbitrary_project_and_volume_kinds_are_rejected(self):
        for value in ('main', 'hosted', '../source', r.SOURCE + '-other'):
            with self.assertRaises(r.Refused):
                r.project(value)
        with self.assertRaises(r.Refused):
            r.volume('secrets', r.SOURCE)

    def test_only_write_helper_keeps_docker_stdin_open_for_tar(self):
        for which in (r.SOURCE, r.TARGET):
            self.assertNotIn('--interactive', r.helper_args('db', which))
        write = r.helper_args('db', r.TARGET, write=True)
        self.assertEqual(write[:2], ['run', '--interactive'])
        self.assertEqual(write.count('--interactive'), 1)
        self.assertNotIn('--tty', write)

    def test_missing_file_500_requires_exact_payload_enoent(self):
        runner = r.Rehearsal.__new__(r.Rehearsal)
        runner.state = {}
        runner.missing_payload = 'stub/fictional/exact-payload'
        obj = {'name': 'fictional/document.txt'}
        cases = [
            (500, {'code': 'InternalError'}, b'ENOENT /mnt/stub/fictional/exact-payload', True),
            (500, {'code': 'InternalError'}, b'ENOENT /mnt/stub/fictional/another-payload', False),
            (500, {'code': 'InternalError'}, b'ENOENT /mnt/stub/fictional/exact-payload-other', False),
            (500, {'code': 'InternalError'}, b'permission denied /mnt/stub/fictional/exact-payload', False),
            (500, {'code': 'UnknownError'}, b'ENOENT /mnt/stub/fictional/exact-payload', False),
            (401, {'code': 'InternalError'}, b'ENOENT /mnt/stub/fictional/exact-payload', False),
        ]
        for status, body, logs, allowed in cases:
            with self.subTest(status=status, body=body, logs=logs), \
                    patch.object(runner, 'service_key', return_value='synthetic-key'), \
                    patch.object(runner, 'private_json'), patch.object(runner, 'save'), \
                    patch.object(r, 'local_http', return_value=(status, json.dumps(body).encode())), \
                    patch.object(r, 'docker', return_value=logs):
                if allowed:
                    self.assertIsNone(runner.object_bytes(r.TARGET, obj, missing=True))
                else:
                    with self.assertRaisesRegex(r.Refused, 'MISSING_OBJECT_FAILURE_NOT_PROVEN'):
                        runner.object_bytes(r.TARGET, obj, missing=True)

    def test_private_destination_must_be_new_fixed_task_sibling(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(r, 'WORK', Path(tmp)):
            good = Path(tmp) / 'office-restore-private-test'
            self.assertEqual(r.private_path(good), good)
            for bad in (Path(tmp) / 'outside', Path('/tmp/office-restore-private-test')):
                with self.assertRaises(r.Refused):
                    r.private_path(bad)
            good.mkdir()
            with self.assertRaises(r.Refused):
                r.private_path(good)

    def test_archive_retains_exact_payload_hash_and_numeric_ownership(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'valid.tar'
            archive(path, [payload()])
            found = r.archive_manifest(path)
            self.assertEqual(found['.'], {'kind': 'dir', 'size': 0, 'uid': 100, 'gid': 101, 'mode': 0o700})
            self.assertEqual(found['stub/photo/version']['sha256'], r.digest(b'fictional image bytes'))

    def test_archive_traversal_absolute_and_link_entries_are_rejected(self):
        for name in ('/etc/file', '../file', 'safe/../../file', 'safe\\file'):
            with self.subTest(name=name), self.assertRaises(r.Refused):
                r.safe_member(payload(name)[0])
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE):
            member = tarfile.TarInfo('link-or-device')
            member.type = kind
            with self.assertRaises(r.Refused):
                r.safe_member(member)

    def test_archive_setuid_and_duplicate_entries_are_rejected(self):
        member, data = payload()
        member.mode = 0o4755
        with self.assertRaises(r.Refused):
            r.safe_member(member)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'duplicate.tar'
            archive(path, [payload(), payload()])
            with self.assertRaisesRegex(r.Refused, 'DUPLICATE'):
                r.archive_manifest(path)

    def test_missing_fixture_does_not_modify_pristine_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            source, missing, only = folder / 'source.tar', folder / 'missing.tar', folder / 'only.tar'
            archive(source, [payload(), payload('stub/photo/version.json', b'fictional metadata')])
            before = r.file_hash(source)
            r.filtered_archive(source, missing, omit='stub/photo/version')
            self.assertNotIn('stub/photo/version', r.archive_manifest(missing))
            self.assertIn('stub/photo/version.json', r.archive_manifest(missing))
            r.filtered_archive(source, only, only='stub/photo/version')
            with tarfile.open(only) as restored:
                self.assertEqual(restored.getnames(), ['stub/photo/version'])
                self.assertEqual(restored.extractfile('stub/photo/version').read(), b'fictional image bytes')
            self.assertEqual(r.file_hash(source), before)
            with self.assertRaises(r.Refused):
                r.filtered_archive(source, missing, omit='stub/photo/version')

    def test_target_configuration_changes_only_project_and_local_ports(self):
        source = SYNTHETIC_CONFIG
        modified = r.tomllib.loads(r.target_config(source).decode())
        self.assertEqual(modified['project_id'], r.TARGET)
        self.assertEqual(modified['api']['port'], 55421)
        self.assertEqual(modified['db']['port'], 55422)
        self.assertEqual(modified['local_smtp']['port'], 55424)
        self.assertFalse(modified['api']['auto_expose_new_tables'])
        for bad in (source.replace(r.SOURCE.encode(), b'hosted-project'), source.replace(b'port = 55321', b'port = 443')):
            with self.assertRaises(r.Refused):
                r.target_config(bad)

    def test_outbound_smtp_configuration_is_refused(self):
        source = SYNTHETIC_CONFIG
        bad = source + b'\n[auth.email.smtp]\nenabled = true\nhost = "smtp.example.invalid"\n'
        with self.assertRaisesRegex(r.Refused, 'OUTBOUND'):
            r.target_config(bad)

    def test_http_cannot_target_hosted_or_other_local_ports(self):
        with patch.object(r.http.client, 'HTTPConnection') as connection:
            for port, path in ((443, '/storage/v1/object/x'), (55322, '/storage/v1/object/x'),
                               (55421, 'https://example.invalid/storage/v1/object/x'),
                               (55421, '/storage/v1/object/x?secret=bad')):
                with self.assertRaises(r.Refused):
                    r.local_http(port, path)
            connection.assert_not_called()

    def test_http_redirect_is_not_followed(self):
        with patch.object(r.http.client, 'HTTPConnection') as ctor:
            response = ctor.return_value.getresponse.return_value
            response.status, response.read.return_value = 302, b''
            with self.assertRaisesRegex(r.Refused, 'REDIRECT'):
                r.local_http(55421, '/storage/v1/object/public/test')
            self.assertEqual(ctor.call_count, 1)
            self.assertEqual(ctor.call_args.args, ('127.0.0.1', 55421))

    def test_source_fixture_requires_synthetic_users_bans_no_staff_and_photo_links(self):
        baseline = rows()
        r.verify_source_rows(baseline)
        for field, change in (
            ('auth.users', lambda value: value[0].update(email='someone@example.com')),
            ('auth.users', lambda value: value[0].update(banned_until='2020-01-01T00:00:00+00:00')),
            ('public.staff_roles', lambda value: value.append({'role': 'admin'})),
            ('storage.buckets', lambda value: value[0].update(public=True)),
            ('public.membership_history', lambda value: value.clear()),
            ('supabase_migrations.schema_migrations', lambda value: value.pop())):
            changed = copy.deepcopy(baseline)
            change(changed[field])
            with self.subTest(field=field), self.assertRaises(r.Refused):
                r.verify_source_rows(changed)

    def test_fingerprints_are_order_independent_but_detect_real_changes(self):
        baseline = rows()
        reversed_rows = copy.deepcopy(baseline)
        reversed_rows['auth.users'].reverse()
        self.assertEqual(r.snapshot_fingerprints(baseline), r.snapshot_fingerprints(reversed_rows))
        reversed_rows['storage.objects'][0]['last_accessed_at'] = 'a read timestamp'
        self.assertEqual(r.snapshot_fingerprints(baseline), r.snapshot_fingerprints(reversed_rows))
        reversed_rows['public.documents'][0]['storage_path'] = 'changed'
        self.assertNotEqual(r.snapshot_fingerprints(baseline), r.snapshot_fingerprints(reversed_rows))

    def test_foreign_key_query_cannot_inject_identifiers(self):
        definition = {'child_schema': 'public', 'child_table': 'membership_history', 'parent_schema': 'public',
                      'parent_table': 'contacts', 'convalidated': True, 'conmatchtype': 's',
                      'child_columns': ['contact_id'], 'parent_columns': ['id']}
        query = r.foreign_key_query([definition])
        self.assertIn('not exists', query)
        for change in ({'parent_table': 'contacts;drop table auth.users'}, {'child_columns': ['id";drop']},
                       {'convalidated': False}, {'parent_schema': 'unreviewed'}):
            with self.assertRaises(r.Refused):
                r.foreign_key_query([{**definition, **change}])

    def test_failed_subprocess_cannot_expose_raw_diagnostics(self):
        result = subprocess.CompletedProcess(['fictional'], 1, b'private session', b'private password')
        with patch.object(r.subprocess, 'run', return_value=result), self.assertRaises(r.Refused) as failure:
            r.command(['fictional'])
        self.assertEqual(str(failure.exception), 'SUBPROCESS_FAILED')

    def test_offloaded_file_is_rejected_before_any_payload_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'fictional'
            path.write_bytes(b'fixture')
            metadata = type('Metadata', (), {'st_mode': 0o100600, 'st_flags': 0x40000000, 'st_size': 7})()
            with patch.object(Path, 'lstat', return_value=metadata), patch.object(Path, 'read_bytes') as read:
                with self.assertRaisesRegex(r.Refused, 'OFFLOADED'):
                    r.read_bytes(path)
                read.assert_not_called()

    def test_archive_corruption_is_rejected_before_any_restore_helper(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pristine.tar'
            archive(path, [payload()])
            runner = r.Rehearsal.__new__(r.Rehearsal)
            runner.archives = {str(path): (r.file_hash(path), r.archive_manifest(path), True)}
            path.write_bytes(path.read_bytes() + b'corruption')
            with patch.object(runner, 'own_target_volume'), patch.object(runner, 'no_running_mounts'), patch.object(r, 'docker') as docker:
                with self.assertRaisesRegex(r.Refused, 'ARCHIVE_CHANGED'):
                    runner.extract('db', path)
                docker.assert_not_called()


if __name__ == '__main__':
    unittest.main()
