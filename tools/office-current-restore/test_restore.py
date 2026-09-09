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
import sys
sys.dont_write_bytecode = True
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('office_current_restore_tested', Path(__file__).with_name('restore.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

source_spec = importlib.util.spec_from_file_location('source_for_restore_tests', Path(__file__).with_name('prepare_source.py'))
p = importlib.util.module_from_spec(source_spec)
source_spec.loader.exec_module(p)
SYNTHETIC_CONFIG = p.source_config((p.REPO / 'tools/office-local-stack/config.toml').read_bytes())
USER = 'bbdb80fa-cf91-47c1-9622-7e77fa446c9b'
DOCUMENT = '45cd22a1-371a-4a50-9831-d1fb2c72a301'
CONTACT = '50f49316-e14e-40e1-86d7-995875754e1d'
HISTORY = '765831a9-a53b-4b91-ab11-7476e6d9bd76'



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
    result['auth.users'] = [{'id': USER, 'email': f'recovery-{USER}@office-current-recovery.invalid', 'email_confirmed_at': '2026-09-09T00:00:00Z', 'banned_until': '2126-01-01T00:00:00+00:00'}]
    result['auth.identities'] = [{'user_id': USER, 'provider': 'email'}]
    result['supabase_migrations.schema_migrations'] = [{'version': v} for v in r.MIGRATIONS]
    path = USER + '/membership-history/' + DOCUMENT + '.png'
    result['public.documents'] = [{'id': DOCUMENT, 'uploaded_by': USER, 'storage_path': path, 'size_bytes': 24, 'title': 'Fictional recovery source', 'file_name': 'fictional-recovery-original.png'}]
    result['storage.objects'] = [{'bucket_id': 'church-documents', 'name': path, 'metadata': {'size': 24}}]
    result['storage.buckets'] = [{'id': 'church-documents', 'public': False}]
    result['public.contacts'] = [{'id': CONTACT, 'first_name': 'Fictional', 'last_name': 'Recovery Fixture', 'status': 'visitor'}]
    result['public.membership_history'] = [{'id': HISTORY, 'source_document_id': DOCUMENT, 'contact_id': CONTACT, 'event_type': 'Recovery fixture', 'source_label': 'Fictional recovery page'}]
    result['public.audit_log'] = [{'actor_id': USER, 'action': 'insert', 'entity_type': table, 'entity_id': identity} for table, identity in [('contacts', CONTACT), ('documents', DOCUMENT), ('membership_history', HISTORY)]]
    return result


class Guards(unittest.TestCase):
    def test_pgdata_archive_requires_fresh_source_exact_0750_root_metadata(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as tmp:
            for uid, gid, mode in [(100, 101, 0o750), (100, 101, 0o700), (100, 101, 0o755),
                                   (100, 101, 0o777), (0, 101, 0o750), (100, 0, 0o750)]:
                path = Path(tmp) / f'root-{uid}-{gid}-{mode}.tar'
                with tarfile.open(path, 'w') as out:
                    root = tarfile.TarInfo('.')
                    root.type, root.mode, root.uid, root.gid = tarfile.DIRTYPE, mode, uid, gid
                    out.addfile(root)
                inventory = r.archive_manifest(path)
                with self.subTest(uid=uid, gid=gid, mode=mode):
                    if (uid, gid, mode) == (100, 101, 0o750):
                        r.verify_pgdata_root(inventory)
                    else:
                        with self.assertRaisesRegex(r.Refused, 'PGDATA_ROOT_OWNERSHIP_REFUSED'):
                            r.verify_pgdata_root(inventory)

    def test_inspection_requires_exact_source_and_registered_target_networks(self):
        runner = r.Rehearsal.__new__(r.Rehearsal)
        runner.network = r.TARGET + '-loopback-fixture'
        for project, base in [(r.SOURCE, 55600), (r.TARGET, 55700)]:
            expected_network = r.SOURCE + '-loopback' if project == r.SOURCE else runner.network
            services = []
            for index, (service, image) in enumerate(r.IMAGES.items()):
                port = {'db': base + 22, 'kong': base + 21, 'inbucket': base + 24}.get(service)
                row = {'Id': 'fictional-' + str(index), 'Name': '/supabase_' + service + '_' + project,
                       'Image': 'sha256:' + image[1],
                       'HostConfig': {'NetworkMode': expected_network},
                       'Config': {'Labels': {'com.supabase.cli.project': project}, 'Env': []},
                       'State': {'Running': True, 'Health': {'Status': 'healthy'}},
                       'NetworkSettings': {'Ports': {'service/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(port)}]} if port else {}},
                       'Mounts': []}
                if service in ('db', 'storage'):
                    destination = '/var/lib/postgresql/data' if service == 'db' else '/mnt'
                    row['Mounts'] = [{'Type': 'volume', 'Name': r.volume(service, project), 'Destination': destination}]
                    row['Config']['Env'] = ['PGDATA=' + destination] if service == 'db' else [
                        'STORAGE_BACKEND=file', 'FILE_STORAGE_BACKEND_PATH=/mnt', 'TENANT_ID=stub', 'GLOBAL_S3_BUCKET=stub']
                services.append(row)

            def inspected(*args):
                if args[0] == 'inspect':
                    return json.dumps(services).encode()
                self.assertEqual(args[:2], ('ps', '-aq'))
                return '\n'.join(row['Id'] for row in services).encode()

            with patch.object(r, 'docker', side_effect=inspected):
                self.assertEqual(runner.inspections(project), services)
                for wrong in ('host', 'bridge', 'supabase_network_' + project,
                              r.SOURCE + '-loopback' if project == r.TARGET else runner.network):
                    services[0]['HostConfig']['NetworkMode'] = wrong
                    with self.subTest(project=project, network=wrong), self.assertRaisesRegex(r.Refused, 'SERVICE_NETWORK_REFUSED'):
                        runner.inspections(project)
                services[0]['HostConfig']['NetworkMode'] = expected_network
                self.assertEqual(runner.inspections(project), services)

    def test_exact_current_seven_pins_and_old_projects_are_not_repurposed(self):
        self.assertEqual(r.MIGRATIONS, ['20260908220558', '20260908220613', '20260908220623', '20260908220645', '20260908220658', '20260908220707', '20260908220718'])
        self.assertEqual(r.SOURCE_CONFIG_SHA256, '97684b65c3a345d0c47d0a6b5942428aeb0d9f3f89b6657f0bdee8b9c5f2a662')
        manifest = json.loads((r.REPO / 'tools/office-preflight/manifest.json').read_bytes())
        self.assertEqual([(Path(row['path']).name, row['sha256']) for row in manifest['sql_files']], list(r.MIGRATION_FILES))
        for name, checksum in r.MIGRATION_FILES:
            self.assertEqual(r.file_hash(r.REPO / 'supabase/migrations' / name), checksum)
        for predecessor in ['bcbc-office-rehearsal', 'bcbc-office-restore-rehearsal', 'bcbc-office-current-rehearsal', 'bcbc-office-current-rehearsal-v2']:
            with self.subTest(predecessor=predecessor), self.assertRaises(r.Refused):
                r.helper_args('db', predecessor, write=True)

    def test_current_catalog_requires_exact_types_closed_intake_and_no_optional_guard(self):
        good = {'rls_tables': 17, 'relevant_policies': 54, 'intake_entrypoints': 2,
                'intake_paused': True, 'readiness_revision': True, 'optional_account_guard_absent': True}
        r.verify_current_baseline(good)
        for key, value in [('rls_tables', 16), ('relevant_policies', 53), ('intake_entrypoints', 1),
                           ('intake_paused', False), ('intake_paused', 1), ('readiness_revision', False),
                           ('optional_account_guard_absent', False), ('rls_tables', 17.0)]:
            with self.subTest(key=key, value=value), self.assertRaises(r.Refused):
                r.verify_current_baseline({**good, key: value})
        with self.assertRaises(r.Refused):
            r.verify_current_baseline({**good, 'unknown': True})

    def test_source_identity_count_sessions_intake_and_all_history_links_are_required(self):
        good = rows()
        r.verify_source_rows(good)
        mutations = [
            ('auth.users', lambda value: value.append(copy.deepcopy(value[0]))),
            ('auth.users', lambda value: value[0].update(email_confirmed_at=None)),
            ('auth.identities', lambda value: value[0].update(user_id=CONTACT)),
            ('auth.sessions', lambda value: value.append({'user_id': USER})),
            ('public.app_connections', lambda value: value.append({'id': CONTACT})),
            ('public.contacts', lambda value: value[0].update(first_name='Unreviewed')),
            ('public.documents', lambda value: value[0].update(uploaded_by=CONTACT)),
            ('public.documents', lambda value: value[0].update(size_bytes=23)),
            ('public.membership_history', lambda value: value[0].update(contact_id=DOCUMENT)),
            ('public.membership_history', lambda value: value[0].update(source_document_id=HISTORY)),
            ('public.audit_log', lambda value: value[0].update(actor_id=CONTACT)),
            ('public.audit_log', lambda value: value[0].update(action='update')),
        ]
        for table, mutate in mutations:
            changed = copy.deepcopy(good)
            mutate(changed[table])
            with self.subTest(table=table), self.assertRaises(r.Refused):
                r.verify_source_rows(changed)
        missing = copy.deepcopy(good)
        del missing['auth.sessions']
        with self.assertRaises(r.Refused):
            r.snapshot_fingerprints(missing)

    def test_missing_proof_rejects_permission_failures_and_nonexact_payload_paths(self):
        for status in (400, 404):
            for code in ('NoSuchKey', 'NotFound'):
                self.assertEqual(r.missing_object_evidence(status, {'code': code}, 'stub/exact')['http_status'], status)
        for status, code in [(400, 'AccessDenied'), (404, 'UnknownError'), (401, 'NotFound'), (403, 'NoSuchKey'), (500, 'NotFound'), (200, 'NoSuchKey')]:
            with self.subTest(status=status, code=code), self.assertRaises(r.Refused):
                r.missing_object_evidence(status, {'code': code}, 'stub/exact')
        for log in [b'ENOENT /other/mnt/stub/exact', b'ENOENT /mnt/stub/exact-extra', b'ENOENT /mnt/stub/exact/nested', b'ENOENT\n/mnt/stub/exact', b'EACCES /mnt/stub/exact']:
            with self.subTest(log=log), self.assertRaises(r.Refused):
                r.missing_object_evidence(500, {'code': 'InternalError'}, 'stub/exact', log)
        self.assertTrue(r.missing_object_evidence(500, {'code': 'InternalError'}, 'stub/exact', b"ENOENT: open '/mnt/stub/exact'")['exact_missing_payload_enoent'])

    def test_only_local_unmapped_run_owned_target_volumes_can_be_restored(self):
        runner = r.Rehearsal.__new__(r.Rehearsal)
        runner.run_id = 'synthetic-run'
        name = r.volume('db', r.TARGET)
        runner.state = {'created_volumes': [name]}
        details = {'Name': name, 'Driver': 'local', 'Options': {}, 'Mountpoint': '/var/lib/docker/volumes/' + name + '/_data',
                   'Labels': {'com.supabase.cli.project': r.TARGET, 'bcbc.restore.run': runner.run_id}}
        with patch.object(r, 'docker', return_value=json.dumps([details]).encode()):
            runner.own_target_volume('db')
        for key, value in [('Driver', 'nfs'), ('Options', {'device': '/private/source'}), ('Labels', {}), ('Name', r.volume('db', r.SOURCE))]:
            with patch.object(r, 'docker', return_value=json.dumps([{**details, key: value}]).encode()), self.assertRaises(r.Refused):
                runner.own_target_volume('db')
        wrong_run = copy.deepcopy(details)
        wrong_run['Labels']['bcbc.restore.run'] = 'another-run'
        with patch.object(r, 'docker', return_value=json.dumps([wrong_run]).encode()), self.assertRaises(r.Refused):
            runner.own_target_volume('db')
        runner.state['created_volumes'] = []
        with patch.object(r, 'docker') as call, self.assertRaises(r.Refused):
            runner.own_target_volume('db')
        call.assert_not_called()

    def test_failed_extraction_reports_unconfirmed_running_helpers_without_resetting(self):
        runner = r.Rehearsal.__new__(r.Rehearsal)
        runner.state = {'stage': 'restore-into-empty-target-volumes', 'created_volumes': [r.volume('db', r.TARGET)], 'cleanup_unconfirmed': False}
        with patch.object(runner, 'save'), patch.object(runner, 'stop') as stop, patch.object(runner, 'no_running_mounts', side_effect=r.Refused('HELPER_RUNNING')) as mounts:
            result = runner.failed('SUBPROCESS_FAILED')
        self.assertEqual(result['status'], 'failed')
        self.assertTrue(result['cleanup_unconfirmed'])
        mounts.assert_called_once_with(r.TARGET)
        stop.assert_not_called()

    def test_public_result_excludes_private_bundle_and_fixture_identifiers(self):
        secret = 'PRIVATE_FIXTURE_' + USER
        state = {'status': 'passed_local_restore_only', 'stage': 'complete', 'checks': [{'check': 'synthetic_verified', 'status': 'passed'}],
                 'source_inventory': {secret: 1}, 'run_id': secret, 'target_network': secret, 'archive_sha256': {'db': secret},
                 'target_config_sha256': secret, 'source_config_sha256': secret, 'private_path': secret, 'restored_object_count': 1}
        output = r.public_report(state)
        self.assertNotIn(secret, json.dumps(output))
        self.assertEqual(output['passed'], 1)
        self.assertEqual(output['migration_count'], 7)
        self.assertIs(output['hosted_changes'], False)
        self.assertIs(output['optional_account_guard_applied'], False)
        self.assertIs(output['public_intake_reopened'], False)

    def test_source_can_never_be_writable_helper_mount(self):
        with self.assertRaisesRegex(r.Refused, 'SOURCE_WRITABLE'):
            r.helper_args('db', r.SOURCE, write=True)
        args = r.helper_args('db', r.SOURCE)
        self.assertIn('--network', args)
        self.assertIn('none', args)
        self.assertIn('type=volume,src=supabase_db_bcbc-office-recovery-source-v1,dst=/volume,volume-nocopy,readonly', args)
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
        with tempfile.TemporaryDirectory(dir='/private/tmp') as tmp, patch.object(r, 'WORK', Path(tmp)), patch.object(r, 'PRIVATE_DIR', Path(tmp) / 'office-restore-private-test'):
            good = Path(tmp) / 'office-restore-private-test'
            self.assertEqual(r.private_path(good), good)
            for bad in (Path(tmp) / 'outside', Path('/tmp/office-restore-private-test')):
                with self.assertRaises(r.Refused):
                    r.private_path(bad)
            good.mkdir()
            with self.assertRaises(r.Refused):
                r.private_path(good)

    def test_archive_retains_exact_payload_hash_and_numeric_ownership(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as tmp:
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
        for key in ('uid', 'gid'):
            member, _ = payload()
            setattr(member, key, 65536)
            with self.subTest(key=key), self.assertRaises(r.Refused):
                r.safe_member(member)
        with tempfile.TemporaryDirectory(dir='/private/tmp') as tmp:
            path = Path(tmp) / 'duplicate.tar'
            archive(path, [payload(), payload()])
            with self.assertRaisesRegex(r.Refused, 'DUPLICATE'):
                r.archive_manifest(path)

    def test_missing_fixture_does_not_modify_pristine_archive(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as tmp:
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
        self.assertEqual(modified['api']['port'], 55721)
        self.assertEqual(modified['db']['port'], 55722)
        self.assertEqual(modified['local_smtp']['port'], 55724)
        self.assertFalse(modified['api']['auto_expose_new_tables'])
        for bad in (source.replace(r.SOURCE.encode(), b'hosted-project'), source.replace(b'port = 55621', b'port = 443')):
            with self.assertRaises(r.Refused):
                r.target_config(bad)

    def test_outbound_smtp_configuration_is_refused(self):
        source = SYNTHETIC_CONFIG
        bad = source + b'\n[auth.email.smtp]\nenabled = true\nhost = "smtp.example.invalid"\n'
        with patch.object(r, 'SOURCE_CONFIG_SHA256', r.digest(bad)), self.assertRaisesRegex(r.Refused, 'OUTBOUND'):
            r.target_config(bad)

    def test_http_cannot_target_hosted_or_other_local_ports(self):
        with patch.object(r.http.client, 'HTTPConnection') as connection:
            for port, path in ((443, '/storage/v1/object/x'), (55622, '/storage/v1/object/x'),
                               (55721, 'https://example.invalid/storage/v1/object/x'),
                               (55721, '/storage/v1/object/x?secret=bad')):
                with self.assertRaises(r.Refused):
                    r.local_http(port, path)
            connection.assert_not_called()

    def test_http_redirect_is_not_followed(self):
        with patch.object(r.http.client, 'HTTPConnection') as ctor:
            response = ctor.return_value.getresponse.return_value
            response.status, response.read.return_value = 302, b''
            with self.assertRaisesRegex(r.Refused, 'REDIRECT'):
                r.local_http(55721, '/storage/v1/object/public/test')
            self.assertEqual(ctor.call_count, 1)
            self.assertEqual(ctor.call_args.args, ('127.0.0.1', 55721))

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
        reversed_rows['public.audit_log'].reverse()
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
        with tempfile.TemporaryDirectory(dir='/private/tmp') as tmp:
            path = Path(tmp) / 'fictional'
            path.write_bytes(b'fixture')
            metadata = type('Metadata', (), {'st_mode': 0o100600, 'st_flags': 0x40000000, 'st_size': 7})()
            with patch.object(Path, 'lstat', return_value=metadata), patch.object(Path, 'read_bytes') as read:
                with self.assertRaisesRegex(r.Refused, 'OFFLOADED'):
                    r.read_bytes(path)
                read.assert_not_called()

    def test_archive_corruption_is_rejected_before_any_restore_helper(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as tmp:
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
