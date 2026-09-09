"""Pure source-seeding guard and mocked-flow tests. No Docker, HTTP or real data."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch
import zlib

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('independently_tested_recovery_seed', Path(__file__).with_name('seed_source.py'))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


def jwt(role):
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    return encode({'alg': 'HS256'}) + '.' + encode({'role': role}) + '.fictional-signature'


def config():
    return {'url': 'http://127.0.0.1:55621', 'anonKey': jwt('anon'), 'serviceKey': jwt('service_role'), 'allowSyntheticWrites': True}


def catalog(final=False):
    counts = {table: 0 for table in s.APP_TABLES}
    if final:
        counts.update(contacts=1, documents=1, membership_history=1, audit_log=3)
    return {'versions': s.VERSIONS[:], 'public_tables': s.APP_TABLES[:], 'rls_tables': 17, 'policies': 54, 'functions': 27,
            'counts': counts, 'auth_users': int(final), 'auth_identities': int(final), 'auth_sessions': 0,
            'active_refresh_tokens': 0, 'confirmed_users': int(final), 'banned_users': int(final), 'objects': int(final),
            'buckets': [{'id': 'church-documents', 'name': 'church-documents', 'public': False, 'file_size_limit': 52428800}],
            'intake_entrypoints': 2, 'intake_grants': 0}


def inspection(kind):
    binding = s.CONTAINERS[kind]
    result = {'name': '/supabase_' + kind + '_' + s.PROJECT, 'running': True,
              'labels': {'com.supabase.cli.project': s.PROJECT}, 'image': s.IMAGES[kind],
              'network_mode': 'bcbc-office-recovery-source-v1-loopback',
              'ports': {} if binding is None else {binding[0]: [{'HostIp': '127.0.0.1', 'HostPort': binding[1]}]}}
    if kind in ('db', 'storage'):
        result['mounts'] = [{'Type': 'volume', 'Name': 'supabase_' + kind + '_' + s.PROJECT,
                             'Destination': '/var/lib/postgresql/data' if kind == 'db' else '/mnt'}]
    return result


class FakeStack:
    def __init__(self):
        self.actions = []
        self.link_checks = 0
        self.api = None

    def catalog(self):
        result = catalog()
        api = self.api
        if api.user:
            result.update(auth_users=1, auth_identities=1, confirmed_users=1,
                          banned_users=int(bool(api.user.get('banned_until'))), auth_sessions=api.sessions,
                          active_refresh_tokens=api.sessions, objects=len(api.objects))
        for table, records in api.records.items():
            result['counts'][table] = len(records)
        result['counts']['audit_log'] = sum(len(records) for records in api.records.values())
        result['counts']['staff_roles'] = int(api.role)
        return result

    def fixture(self, fixture, action):
        fixture.owned()
        self.actions.append(action)
        if action == 'assign':
            self.api.role = True
        elif action == 'contain':
            self.api.role = False
            self.api.sessions = 0
        else:
            raise AssertionError('unexpected fixture action')

    def linkage(self, fixture):
        self.link_checks += 1
        if any(len(self.api.records[table]) != 1 for table in ('contacts', 'documents', 'membership_history')):
            raise s.Refusal('FIXTURE_LINKAGE_UNCONFIRMED')
        contact, doc, history = (self.api.records[table][0] for table in ('contacts', 'documents', 'membership_history'))
        assert history['contact_id'] == contact['id'] == fixture.contact_id
        assert history['source_document_id'] == doc['id'] == fixture.document_id
        assert doc['storage_path'] == fixture.path in self.api.objects


class FakeApi:
    def __init__(self, disabled=False, corrupt_download=False):
        self.user = None
        self.role = False
        self.sessions = 0
        self.records = {table: [] for table in ('contacts', 'documents', 'membership_history')}
        self.objects = {}
        self.calls = []
        self.disabled = disabled
        self.corrupt_download = corrupt_download

    def request(self, path, actor='anon', token=None, method='GET', body=None, binary=False):
        self.calls.append((path, actor, method))
        if path == '/auth/v1/settings':
            return {'status': 200, 'data': {'disable_signup': True, 'external': {'email': not self.disabled}}}
        if path == '/auth/v1/admin/users' and method == 'POST':
            self.user = {'id': body['id'], 'email': body['email'], 'email_confirmed_at': '2026-09-09T00:00:00Z', 'is_anonymous': False}
            return {'status': 200, 'data': dict(self.user)}
        if path.startswith('/auth/v1/admin/users/'):
            assert self.user and path.endswith(self.user['id'])
            if method == 'PUT':
                assert body == {'ban_duration': '87600h'}
                self.user['banned_until'] = '2126-01-01T00:00:00+00:00'
            return {'status': 200, 'data': dict(self.user)}
        if path == '/auth/v1/token?grant_type=password':
            self.sessions = 1
            return {'status': 200, 'data': {'user': dict(self.user), 'access_token': 'synthetic-user-session-for-tests'}}
        if path == '/auth/v1/logout?scope=global':
            self.sessions = 0
            return {'status': 204, 'data': None}
        if path == '/rest/v1/rpc/office_readiness':
            return {'status': 200, 'data': {'schema_revision': '20260907174301', 'staff_role': 'editor'}}
        if path.startswith('/rest/v1/'):
            table = path.split('/')[3].split('?')[0]
            assert method == 'POST' and table in self.records and self.role
            record = dict(body, version=1, created_by=self.user['id'])
            self.records[table].append(record)
            return {'status': 201, 'data': [record]}
        if path.startswith('/storage/v1/object/church-documents/'):
            assert method == 'POST' and actor == 'user' and body == s.ORIGINAL
            self.objects[path.split('/church-documents/', 1)[1]] = body
            return {'status': 200, 'data': {'stored': True}}
        if path.startswith('/storage/v1/object/') and binary:
            if actor == 'anon':
                return {'status': 403, 'data': b'{"code":"AccessDenied"}'}
            data = self.objects[path.split('/church-documents/', 1)[1]]
            return {'status': 200, 'data': b'corrupt synthetic bytes' if self.corrupt_download else data}
        raise AssertionError('unexpected synthetic API request')


class SeedGuards(unittest.TestCase):
    def test_exact_stdin_input_roles_origin_and_environment(self):
        s.validate_config(config())
        self.assertEqual(s.read_config(io.BytesIO(json.dumps(config()).encode())), config())
        for key, value in [('url', 'https://sample.supabase.co'), ('url', 'http://127.0.0.1:55521'),
                           ('url', 'http://localhost:55621'), ('url', 'http://127.0.0.1:55721'),
                           ('allowSyntheticWrites', 1), ('serviceKey', jwt('anon')), ('anonKey', jwt('service_role'))]:
            with self.subTest(key=key), self.assertRaises(s.Refusal):
                s.validate_config({**config(), key: value})
        for raw in [b'{"url":"PRIVATE","url":"PRIVATE2"}', b'null', b'PRIVATE' * 50000]:
            with self.assertRaises(s.Refusal) as failure:
                s.read_config(io.BytesIO(raw))
            self.assertNotIn('PRIVATE', s.safe_error(failure.exception))
        for key in ('DOCKER_HOST', 'HTTP_PROXY', 'PYTHONPATH', 'DYLD_INSERT_LIBRARIES'):
            with self.assertRaises(s.Refusal):
                s.validate_environment({key: 'PRIVATE'})
        for arguments in [[], ['--run'], ['--run', '--stdin', '--reset'], ['--run', '--stdin', '--url', s.ORIGIN]]:
            with self.assertRaises(s.Refusal):
                s.parse_args(arguments)

    def test_six_images_loopback_ports_fixed_network_and_owned_mounts(self):
        self.assertEqual(len(s.CONTAINERS), 6)
        self.assertEqual(s.CONTAINERS['inbucket'], ('8025/tcp', '55624'))
        self.assertEqual(s.NETWORK, 'bcbc-office-recovery-source-v1-loopback')
        for kind in s.CONTAINERS:
            good = inspection(kind)
            s.validate_inspection(good, kind)
            for key, value in [('name', '/supabase_db_bcbc-office-current-rehearsal-v2'), ('running', False),
                               ('labels', {}), ('image', 'sha256:' + '0' * 64), ('network_mode', 'host'),
                               ('network_mode', 'supabase_network_bcbc-office-recovery-source-v1'),
                               ('ports', {'9999/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '55621'}]})]:
                with self.subTest(kind=kind, key=key), self.assertRaises(s.Refusal):
                    s.validate_inspection({**good, key: value}, kind)
            if kind in ('db', 'storage'):
                changed = copy.deepcopy(good)
                changed['mounts'][0]['Name'] = 'supabase_db_bcbc-office-rehearsal'
                with self.assertRaises(s.Refusal):
                    s.validate_inspection(changed, kind)

    def test_virgin_and_final_catalog_refuse_other_data_active_access_or_optional_migrations(self):
        s.validate_catalog(catalog(), virgin=True)
        s.validate_catalog(catalog(True), final=True)
        for key, value in [('versions', s.VERSIONS[:-1]), ('policies', 53), ('functions', 28),
                           ('auth_users', 1), ('objects', 1), ('intake_grants', 1)]:
            with self.subTest(key=key), self.assertRaises(s.Refusal):
                s.validate_catalog({**catalog(), key: value}, virgin=True)
        for key, value in [('auth_users', 2), ('auth_sessions', 1), ('active_refresh_tokens', 1), ('banned_users', 0)]:
            with self.subTest(key=key), self.assertRaises(s.Refusal):
                s.validate_catalog({**catalog(True), key: value}, final=True)
        for table in ('staff_roles', 'app_connections', 'guest_intakes', 'events'):
            changed = catalog(True)
            changed['counts'][table] = 1
            with self.assertRaises(s.Refusal):
                s.validate_catalog(changed, final=True)

    def test_original_is_exact_small_crc_valid_png(self):
        self.assertEqual(len(s.ORIGINAL), 68)
        self.assertEqual(hashlib.sha256(s.ORIGINAL).hexdigest(), '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460')
        self.assertEqual(s.ORIGINAL[:8], b'\x89PNG\r\n\x1a\n')
        offset, names = 8, []
        while offset < len(s.ORIGINAL):
            length = struct.unpack('>I', s.ORIGINAL[offset:offset + 4])[0]
            chunk = s.ORIGINAL[offset + 4:offset + 8 + length]
            crc = struct.unpack('>I', s.ORIGINAL[offset + 8 + length:offset + 12 + length])[0]
            self.assertEqual(zlib.crc32(chunk) & 0xffffffff, crc)
            names.append(chunk[:4])
            offset += 12 + length
        self.assertEqual(names, [b'IHDR', b'IDAT', b'IEND'])
        self.assertEqual(offset, len(s.ORIGINAL))

    def test_generated_identity_guards_every_fixture_statement_and_link(self):
        fixture = s.Fixture()
        identity = fixture.owned()
        for action in ('assign', 'contain'):
            sql = s.fixture_statement(fixture, action)
            self.assertIn("id='" + identity['id'] + "'::uuid and email='" + identity['email'] + "'", sql)
            self.assertLess(sql.index('FIXTURE_IDENTITY_MISMATCH'), sql.index('insert into' if action == 'assign' else 'delete from'))
            self.assertNotIn('delete from auth.users', sql)
            self.assertNotIn('truncate', sql)
        link = s.linkage_statement(fixture)
        self.assertIn('begin read only', link)
        for expected in [fixture.path, fixture.contact_id, fixture.document_id, fixture.history_id]:
            self.assertIn(expected, link)
        with self.assertRaises(s.Refusal):
            s.fixture_statement(fixture, 'reset')
        fixture.user['email'] = 'someone@example.org'
        with self.assertRaises(s.Refusal):
            s.fixture_statement(fixture, 'contain')
        fixture = s.Fixture()
        fixture.document_id = fixture.contact_id
        with self.assertRaises(s.Refusal):
            fixture.owned()

    def test_invalid_http_paths_actors_and_originals_stop_before_network(self):
        stack = unittest.mock.Mock()
        api = s.LocalApi(config(), stack)
        with patch.object(s.http.client, 'HTTPConnection', side_effect=AssertionError('No network permitted')):
            for path in ['https://example.invalid/rest/v1/contacts', '/auth/v1/../admin/users', '/auth//v1/users', '/auth/v1/users\r\nPRIVATE']:
                with self.assertRaises(s.Refusal):
                    api.request(path)
            for arguments in [dict(actor='unknown'), dict(method='DELETE'), dict(actor='user', token='short')]:
                with self.assertRaises(s.Refusal):
                    api.request('/rest/v1/contacts', **arguments)
            with self.assertRaises(s.Refusal):
                api.request('/storage/v1/object/church-documents/fixture', actor='user', token='synthetic-user-session-for-tests', method='POST', body=b'unapproved bytes')

    def test_mocked_disabled_provider_never_creates_an_identity_or_mutates_data(self):
        stack, api = FakeStack(), FakeApi(disabled=True)
        stack.api = api
        report = s.run(config(), stack=stack, api=api)
        self.assertEqual(report['status'], 'failed_or_incomplete')
        self.assertEqual(report['cleanup'], {})
        self.assertEqual(stack.actions, [])
        self.assertIsNone(api.user)
        self.assertEqual(api.calls, [('/auth/v1/settings', 'anon', 'GET')])

    def test_mocked_success_retains_exact_linked_fixture_and_contains_only_its_account(self):
        stack, api = FakeStack(), FakeApi()
        stack.api = api
        report = s.run(config(), stack=stack, api=api)
        self.assertEqual(report['status'], 'prepared_source_contained')
        self.assertEqual((report['passed'], report['failed']), (5, 0))
        self.assertEqual(stack.actions, ['assign', 'contain'])
        self.assertEqual(stack.link_checks, 2)
        self.assertEqual(report['cleanup'], {'api_logout': 'confirmed', 'role_and_session_cleanup': 'confirmed', 'auth_ban': 'confirmed'})
        self.assertEqual(report['final_counts'], {'auth_users': 1, 'banned_auth_users': 1, 'staff_roles': 0, 'sessions': 0, 'contacts': 1, 'documents': 1, 'history_entries': 1, 'objects': 1, 'app_connections': 0, 'guest_intakes': 0})
        serialized = json.dumps(report)
        for private in [api.user['id'], api.user['email'], *api.objects.keys(), config()['anonKey'], config()['serviceKey']]:
            self.assertNotIn(private, serialized)
        self.assertFalse(report['restore_performed'])
        self.assertFalse(report['hosted_calls'])

    def test_bad_original_bytes_cannot_be_reported_as_success_even_if_cleanup_passes(self):
        stack, api = FakeStack(), FakeApi(corrupt_download=True)
        stack.api = api
        report = s.run(config(), stack=stack, api=api)
        self.assertEqual(report['status'], 'failed_or_incomplete')
        self.assertGreater(report['failed'], 0)
        self.assertEqual(report['cleanup']['auth_ban'], 'confirmed')
        self.assertEqual(report['cleanup']['role_and_session_cleanup'], 'confirmed')


if __name__ == '__main__':
    unittest.main()
