"""Pure acceptance guard/failure-path tests: no actual Docker, HTTP or accounts."""
import base64
import copy
import io
import json
import stat
import time
import types
import unittest
from unittest import mock
from urllib.parse import urlsplit, parse_qs

import check_service as c


def jwt(role, **claims):
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    return encode({'alg': 'HS256'}) + '.' + encode(dict(role=role, **claims)) + '.fictionalsignature'


def config():
    return {'url': c.ORIGIN, 'anonKey': jwt('anon'), 'serviceKey': jwt('service_role'), 'allowSyntheticWrites': True}


def inspection(kind):
    binding = c.CONTAINERS[kind]
    ports = {} if binding is None else {binding[0]: [{'HostIp': '127.0.0.1', 'HostPort': binding[1]}]}
    mounts = []
    if kind in ('db', 'storage'):
        mounts = [{'Type': 'volume', 'Name': 'supabase_' + kind + '_' + c.PROJECT,
                   'Destination': '/mnt' if kind == 'storage' else '/var/lib/postgresql/data'}]
    return {'name': '/supabase_' + kind + '_' + c.PROJECT, 'running': True, 'image': c.IMAGES[kind],
            'labels': {'com.supabase.cli.project': c.PROJECT}, 'network_mode': c.NETWORK,
            'ports': dict(ports, **{'1234/tcp': None}), 'mounts': mounts}


def catalog():
    return {'versions': c.VERSIONS[:], 'public_tables': c.APP_TABLES[:], 'rls_tables': 17, 'policies': 54,
            'functions': 27, 'guard': {'body': c.expected_guard_body(), 'definer': True, 'stable': True,
                'return_type': True, 'settings': ['search_path=""'], 'owner': 'postgres', 'anon_execute': False,
                'authenticated_execute': True, 'public_execute': False},
            'counts': {table: 0 for table in c.APP_TABLES}, 'auth_users': 0, 'identities': 0, 'sessions': 0,
            'refresh_tokens': 0, 'confirmed_users': 0, 'banned_users': 0, 'objects': 0,
            'intake_entrypoints': 2, 'intake_access': False,
            'buckets': [{'id': 'church-documents', 'name': 'church-documents', 'public': False, 'file_size_limit': 52428800}]}


class Guards(unittest.TestCase):
    def test_only_exact_stdin_cli_and_explicit_local_actor_keys(self):
        c.parse_args(['--run', '--stdin'])
        c.validate_config(config())
        for args in ([], ['--stdin', '--run'], ['--run', '--stdin', '--reset'], ['--help']):
            with self.assertRaises(c.Refusal):
                c.parse_args(args)
        for field, value in [('url', 'https://fictional.supabase.co'), ('url', 'http://localhost:55821'),
                             ('url', 'http://127.0.0.1:55721'), ('url', c.ORIGIN + '/'),
                             ('url', 'http://192.168.1.2:55821'), ('url', c.ORIGIN + '@evil.invalid'),
                             ('allowSyntheticWrites', 1), ('anonKey', jwt('service_role')), ('serviceKey', jwt('anon'))]:
            with self.subTest(field=field), self.assertRaises(c.Refusal):
                c.validate_config(dict(config(), **{field: value}))
        with self.assertRaises(c.Refusal):
            c.validate_config(dict(config(), sql='select private'))

    def test_bounded_input_duplicate_fields_and_invalid_json_never_echo(self):
        self.assertEqual(c.read_config(io.BytesIO(json.dumps(config()).encode())), config())
        for raw in (b'x' * 32769, b'{"url":"secret-one","url":"secret-two"}', b'{"secret":', b'null'):
            with self.assertRaises(c.Refusal) as caught:
                c.read_config(io.BytesIO(raw))
            self.assertNotIn('secret', c.safe_error(caught.exception).lower())

    def test_environment_and_socket_cannot_retarget_transport(self):
        c.validate_environment({'PATH': '/usr/bin:/bin', 'NO_PROXY': ''})
        for key in ('HTTP_PROXY', 'no_proxy', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT',
                    'PYTHONPATH', 'PYTHONINSPECT', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'NODE_DEBUG'):
            with self.subTest(key=key), self.assertRaises(c.Refusal):
                c.validate_environment({key: 'fictional'})
        info = types.SimpleNamespace(st_mode=stat.S_IFSOCK | 0o600, st_uid=501)
        c.pure.validate_socket(info, c.pure.PHYSICAL_SOCKET, 501)
        for args in [(info, '/private/tmp/other.sock', 501), (info, c.pure.PHYSICAL_SOCKET, 502),
                     (types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=501), c.pure.PHYSICAL_SOCKET, 501)]:
            with self.assertRaises(c.Refusal):
                c.pure.validate_socket(*args)

    def test_six_images_exact_network_labels_and_only_intended_ports(self):
        for kind in c.CONTAINERS:
            good = inspection(kind)
            c.validate_inspection(good, kind)
            for field, value in [('name', '/supabase_' + kind + '_bcbc-office-current-rehearsal-v2'),
                                 ('running', False), ('image', 'sha256:unpinned'), ('labels', {}),
                                 ('network_mode', 'host'), ('network_mode', 'supabase_network_' + c.PROJECT)]:
                with self.subTest(kind=kind, field=field), self.assertRaises(c.Refusal):
                    c.validate_inspection(dict(good, **{field: value}), kind)
            extra = copy.deepcopy(good)
            extra['ports']['9999/tcp'] = [{'HostIp': '127.0.0.1', 'HostPort': '55829'}]
            with self.assertRaises(c.Refusal):
                c.validate_inspection(extra, kind)
            if c.CONTAINERS[kind]:
                port, host = c.CONTAINERS[kind]
                for binding in ([{'HostIp': '0.0.0.0', 'HostPort': host}],
                                [{'HostIp': '127.0.0.1', 'HostPort': '55521'}], []):
                    changed = copy.deepcopy(good)
                    changed['ports'][port] = binding
                    with self.assertRaises(c.Refusal):
                        c.validate_inspection(changed, kind)

    def test_storage_db_volumes_and_mail_internal_port_are_not_guessed(self):
        for kind in ('db', 'storage'):
            for field, value in [('Type', 'bind'), ('Name', 'supabase_' + kind + '_other'), ('Destination', '/other')]:
                changed = inspection(kind)
                changed['mounts'][0][field] = value
                with self.assertRaises(c.Refusal):
                    c.validate_inspection(changed, kind)
        mail = inspection('inbucket')
        mail['ports']['9000/tcp'] = mail['ports'].pop('8025/tcp')
        with self.assertRaises(c.Refusal):
            c.validate_inspection(mail, 'inbucket')

    def test_prepared_source_and_socket_are_checked_before_any_docker_inspect(self):
        stack = c.LocalStack()
        with (mock.patch.object(c.prep, 'verify_prepared_source', side_effect=RuntimeError('private data')),
              mock.patch.object(stack, '_docker') as docker):
            with self.assertRaises(c.Refusal):
                stack.verify()
            docker.assert_not_called()

    def test_catalog_pins_actual_guard_body_acl_and_eight_versions(self):
        c.validate_catalog(catalog(), virgin=True)
        self.assertEqual(tuple(c.VERSIONS), c.prep.VERSIONS)
        for field, value in [('versions', c.VERSIONS[:-1]), ('versions', c.VERSIONS + ['20260910000000']),
                             ('functions', 26), ('policies', 53), ('public_tables', c.APP_TABLES[:-1]),
                             ('intake_access', True), ('intake_entrypoints', 1), ('sessions', False)]:
            with self.subTest(field=field), self.assertRaises(c.Refusal):
                c.validate_catalog(dict(catalog(), **{field: value}), virgin=True)
        for field, value in [('body', '\nselect role from public.staff_roles;\n'), ('definer', False),
                             ('settings', ['search_path=public']), ('anon_execute', True), ('owner', 'other'),
                             ('public_execute', True), ('authenticated_execute', 1)]:
            changed = catalog()
            changed['guard'][field] = value
            with self.subTest(field=field), self.assertRaises(c.Refusal):
                c.validate_catalog(changed)

    def test_no_replay_or_unpaused_intake_can_pass_initial_gate(self):
        for field in ('auth_users', 'identities', 'sessions', 'refresh_tokens', 'objects'):
            with self.subTest(field=field), self.assertRaises(c.Refusal):
                c.validate_catalog(dict(catalog(), **{field: 1}), virgin=True)
        for table in c.APP_TABLES:
            changed = catalog()
            changed['counts'][table] = 1
            with self.subTest(table=table), self.assertRaises(c.Refusal):
                c.validate_catalog(changed, virgin=True)
        changed = catalog()
        changed['buckets'][0]['public'] = True
        with self.assertRaises(c.Refusal):
            c.validate_catalog(changed)

    def test_final_contains_only_expected_retained_synthetic_rows(self):
        final = catalog()
        final.update(auth_users=4, identities=4, confirmed_users=4, banned_users=4, objects=1)
        final['counts'].update(contacts=1, documents=1, audit_log=3)
        c.validate_catalog(final, final=True)
        for field, value in [('sessions', 1), ('refresh_tokens', 1), ('banned_users', 3), ('objects', 2)]:
            with self.assertRaises(c.Refusal):
                c.validate_catalog(dict(final, **{field: value}), final=True)
        for table in ['staff_roles', 'membership_history', 'app_connections']:
            changed = copy.deepcopy(final)
            changed['counts'][table] = 1
            with self.assertRaises(c.Refusal):
                c.validate_catalog(changed, final=True)

    def test_registry_generated_identity_and_sql_require_exact_owned_binding(self):
        registry = c.Registry()
        for role in c.ROLES:
            user = registry.register(role)
            self.assertTrue(user['email'].endswith('@office-account-guard.invalid'))
            for action in ('revoke', 'contain'):
                sql = c.fixture_statement(registry, action, role)
                self.assertIn("id='" + user['id'] + "'::uuid and email='" + user['email'] + "' for update", sql)
                self.assertLess(sql.index('FIXTURE_IDENTITY_MISMATCH'), sql.index('delete from public.staff_roles'))
                self.assertNotIn('delete from auth.users', sql)
                if action == 'contain':
                    self.assertIn("delete from auth.sessions where user_id='" + user['id'] + "'::uuid", sql)
                    self.assertIn("delete from auth.refresh_tokens where user_id='" + user['id'] + "'", sql)
            if role != 'nonstaff':
                self.assertIn('FIXTURE_NOT_ELIGIBLE', c.fixture_statement(registry, 'assign', role))
        for action, role in [('reset', 'admin'), ('assign', 'nonstaff'), ('contain', 'outsider')]:
            with self.assertRaises(c.Refusal):
                c.fixture_statement(registry, action, role)
        registry.users['editor']['email'] = 'someone@example.org'
        with self.assertRaises(c.Refusal):
            c.fixture_statement(registry, 'contain', 'editor')

    def test_registry_rejects_injected_duplicate_or_unregistered_ids(self):
        registry = c.Registry()
        with self.assertRaises(c.Refusal):
            registry.object_path()
        user = registry.register('editor')
        for bad in [registry.contact_id, "uuid'; delete from auth.users;--", 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']:
            user['id'] = bad
            with self.assertRaises(c.Refusal):
                c.fixture_statement(registry, 'contain', 'editor')

    def test_permission_errors_require_exact_meaning_and_positive_control_scope(self):
        c.denied({'status': 403, 'data': {'code': '42501'}})
        c.storage_denied({'status': 403, 'data': {'code': 'AccessDenied'}})
        c.storage_denied({'status': 404, 'data': b'{"code":"NoSuchKey"}'}, existing_object=True)
        failures = [{'status': 500, 'data': {'code': 'AccessDenied'}}, {'status': 403, 'data': {'code': 'InvalidJWT'}},
                    {'status': 404, 'data': {'code': 'NoSuchBucket'}}, {'status': 400, 'data': {'code': 'DatabaseError'}},
                    {'status': 403, 'data': {}}, {'status': 401, 'data': b'not json'}]
        for response in failures:
            with self.assertRaises(c.Refusal):
                c.storage_denied(response, existing_object=True)
        with self.assertRaises(c.Refusal):
            c.storage_denied({'status': 404, 'data': {'code': 'NoSuchKey'}})
        for response in [{'status': 401, 'data': {'code': 'PGRST301'}}, {'status': 500, 'data': {'code': '42501'}}, {'status': 200, 'data': []}]:
            with self.assertRaises(c.Refusal):
                c.denied(response)
        with self.assertRaises(c.Refusal):
            c.empty({'status': 403, 'data': []})

    def test_private_bucket_hidden_response_is_only_public_route_evidence(self):
        hidden = {'status': 404, 'data': b'{"code":"NoSuchBucket"}'}
        c.public_private_bucket_hidden(hidden)
        c.public_private_bucket_hidden({'status': 403, 'data': {'code': 'AccessDenied'}})
        for existing in (False, True):
            with self.assertRaises(c.Refusal):
                c.storage_denied(hidden, existing_object=existing)
        for response in [{'status': 500, 'data': {'code': 'NoSuchBucket'}},
                         {'status': 401, 'data': {'code': 'NoSuchBucket'}},
                         {'status': 404, 'data': {'code': 'InvalidJWT'}}]:
            with self.assertRaises(c.Refusal):
                c.public_private_bucket_hidden(response)

    def test_signed_urls_cannot_escape_origin_object_or_single_token(self):
        registry = c.Registry()
        registry.register('editor')
        path = registry.object_path()
        relative = '/object/sign/church-documents/' + path + '?token=a.b.c'
        self.assertEqual(c.signed_path(relative, path), '/storage/v1' + relative)
        self.assertEqual(c.signed_path(c.ORIGIN + '/storage/v1' + relative, path), '/storage/v1' + relative)
        for value in ['https://evil.invalid/storage/v1' + relative, c.ORIGIN + '/storage/v1' + relative + '#hash',
                      relative + '&token=x.y.z', relative.replace(path, '../wrong'), relative + '&download=x',
                      'http://127.0.0.1:55721/storage/v1' + relative]:
            with self.assertRaises(c.Refusal):
                c.signed_path(value, path)

    def test_ban_and_bytes_need_actual_positive_results(self):
        c.ban_until({'banned_until': '2999-01-01T00:00:00Z'}, True)
        c.ban_until({'banned_until': None}, False)
        c.ban_until({'banned_until': '2000-01-01T00:00:00Z'}, False)
        for value, banned in [(None, True), ('nonsense', True), ('2999-01-01T00:00:00Z', False)]:
            with self.assertRaises(c.Refusal):
                c.ban_until({'banned_until': value}, banned)
        c.confirmed_download({'status': 200, 'data': c.ORIGINAL})
        for response in [{'status': 403, 'data': c.ORIGINAL}, {'status': 200, 'data': b'wrong image'}]:
            with self.assertRaises(c.Refusal):
                c.confirmed_download(response)

    def test_http_unsafe_path_and_failed_topology_never_send_credentials(self):
        stack = mock.Mock()
        api = c.LocalApi(config(), stack)
        with mock.patch.object(c.http.client, 'HTTPConnection') as connection:
            for path in ['https://evil.invalid/auth/v1/admin/users', '/auth/v1/../admin/users',
                         '/auth/v1/users\r\nAuthorization: private', '/auth//v1/users']:
                with self.assertRaises(c.Refusal):
                    api.request(path)
            stack.verify.assert_not_called()
            stack.verify.side_effect = c.Refusal('CONTAINER_UNVERIFIED')
            with self.assertRaises(c.Refusal):
                api.request('/auth/v1/admin/users', actor='service', method='POST', body={})
            connection.assert_not_called()

    def test_http_fixed_destination_no_redirect_and_original_only(self):
        stack = mock.Mock()
        api = c.LocalApi(config(), stack)
        response = mock.Mock(status=200)
        response.read.return_value = b'{}'
        connection = mock.Mock()
        connection.getresponse.return_value = response
        with mock.patch.object(c.http.client, 'HTTPConnection', return_value=connection) as constructor:
            api.request('/auth/v1/settings')
            constructor.assert_called_once_with('127.0.0.1', 55821, timeout=15)
            response.status = 302
            with self.assertRaises(c.Refusal):
                api.request('/auth/v1/settings')
            with self.assertRaises(c.Refusal):
                api.request('/storage/v1/object/church-documents/fake', 'user', jwt('authenticated'), 'POST', b'not approved bytes')
        self.assertEqual(c.safe_error(RuntimeError('PRIVATE_RESPONSE')), 'UNEXPECTED_FAILURE_REDACTED')


class FakeServices:
    """Fictional in-memory service model for runner control-flow/failure tests."""
    def __init__(self, fault=None):
        self.fault = fault
        self.users, self.roles, self.sessions, self.tokens = {}, {}, set(), {}
        self.contact, self.document, self.original = None, None, None
        self.contained, self.requests, self.ban_transitions = [], [], []

    def verify(self):
        pass

    def catalog(self):
        value = catalog()
        value.update(auth_users=len(self.users), identities=len(self.users), confirmed_users=len(self.users),
                     banned_users=sum(bool(u.get('banned_until')) for u in self.users.values()),
                     sessions=len(self.sessions), refresh_tokens=len(self.sessions), objects=int(self.original is not None))
        value['counts'].update(staff_roles=len(self.roles), contacts=int(self.contact is not None),
                               documents=int(self.document is not None), audit_log=(2 if self.contact else 0) + int(self.document is not None))
        return value

    def content(self):
        return copy.deepcopy({'contact': self.contact, 'document': self.document, 'original': self.original})

    def fixture(self, registry, action, role):
        user = registry.owned(role)
        if self.users.get(user['id'], {}).get('email') != user['email']:
            raise c.Refusal('FIXTURE_IDENTITY_MISMATCH')
        c.fixture_statement(registry, action, role)
        if action == 'assign':
            self.roles[user['id']] = role
        else:
            self.roles.pop(user['id'], None)
            if action == 'contain':
                self.contained.append(role)
                self.sessions.discard(user['id'])

    def request(self, path, actor='anon', token=None, method='GET', body=None, binary=False):
        self.requests.append((path, actor, token, method))
        response = lambda data, status=200: {'status': status, 'data': data}
        uid = self.tokens.get(token)
        role = self.roles.get(uid) if not self.users.get(uid, {}).get('banned_until') else None
        write = role in ('admin', 'editor')
        if path == '/auth/v1/settings':
            return response({'disable_signup': True, 'external': {'email': self.fault != 'provider'}})
        if path == '/auth/v1/admin/users' and method == 'POST':
            self.users[body['id']] = dict(id=body['id'], email=body['email'], email_confirmed_at='2026-09-09', is_anonymous=False)
            return response(copy.deepcopy(self.users[body['id']]))
        if path.startswith('/auth/v1/admin/users/'):
            user = self.users[path.rsplit('/', 1)[-1]]
            if self.fault == 'lost-token-and-admin-get':
                raise RuntimeError('PRIVATE_AUTH_IDENTITY_RESPONSE')
            if method == 'PUT':
                user['banned_until'] = '2999-01-01T00:00:00Z' if body['ban_duration'] != 'none' else None
                self.ban_transitions.append((user['id'], bool(user['banned_until'])))
            return response(copy.deepcopy(user))
        if path.startswith('/auth/v1/token'):
            user = next(u for u in self.users.values() if u['email'] == body['email'])
            access = jwt('authenticated', sub=user['id'], exp=int(time.time()) + 3600)
            self.tokens[access] = user['id']
            self.sessions.add(user['id'])
            if self.fault == 'lost-token-and-admin-get':
                raise RuntimeError('PRIVATE_TOKEN_PASSWORD_RESPONSE')
            return response({'user': copy.deepcopy(user), 'access_token': access})
        if path.startswith('/auth/v1/logout'):
            self.sessions.discard(uid)
            return response(None, 204)
        if path == '/rest/v1/rpc/office_readiness':
            return response({'schema_revision': c.REVISION, 'staff_role': role}) if role else response({'code': '42501'}, 403)
        if path.startswith('/rest/v1/rpc/'):
            return response({'code': '42501'}, 403)
        if path.startswith('/rest/v1/staff_roles?'):
            return response([{'user_id': uid, 'role': self.roles[uid]}] if uid in self.roles else [])
        if path.startswith('/rest/v1/contacts?'):
            if method == 'GET':
                return response([{'id': self.contact['id']}] if role and self.contact else [])
            if not write:
                if self.fault == 'jwt-denial' and self.roles.get(uid) == 'viewer':
                    return response({'code': 'PGRST301'}, 401)
                return response({'code': '42501'}, 403)
            self.contact = dict(body, version=1) if method == 'POST' else dict(self.contact, **body, version=2)
            return response([copy.deepcopy(self.contact)], 201 if method == 'POST' else 200)
        if path.startswith('/rest/v1/documents?'):
            self.document = dict(body, version=1)
            return response([copy.deepcopy(self.document)], 201)
        if path.startswith('/storage/v1/object/sign/'):
            if method == 'GET':
                return response(c.ORIGINAL)
            if not role:
                return response({'code': 'AccessDenied'}, 403)
            return response({'signedURL': path.replace('/storage/v1', '', 1) + '?token=a.b.c'})
        if path.startswith('/storage/v1/object/public/'):
            return response(json.dumps({'code': 'NoSuchBucket'}).encode(), 404)
        if path.startswith('/storage/v1/object/authenticated/'):
            return response(c.ORIGINAL) if role else response(json.dumps({'code': 'NoSuchKey'}).encode(), 404)
        if path.startswith('/storage/v1/object/church-documents/'):
            if not write:
                return response({'code': 'NoSuchKey' if self.fault == 'upload-missing' else 'AccessDenied'}, 403)
            self.original = path
            return response({'Key': path}, 200)
        raise AssertionError('unexpected fictional request')


class Flow(unittest.TestCase):
    def test_complete_matrix_reuses_existing_token_and_contains_all_four(self):
        fake = FakeServices()
        result = c.run(config(), fake, fake)
        self.assertEqual(result['status'], 'passed_local_guard_http_only', result)
        self.assertEqual(result['passed'], 8)
        self.assertEqual(set(fake.contained), set(c.ROLES))
        self.assertEqual(fake.sessions, set())
        self.assertEqual(fake.roles, {})
        self.assertFalse(result['actual_http_pre_guard_reproduction'])
        self.assertFalse(result['signed_url_revocation_claimed'])
        editor = next(uid for uid, user in fake.users.items() if '-editor@' in user['email'])
        used = {token for _, actor, token, _ in fake.requests if actor == 'user' and fake.tokens.get(token) == editor}
        self.assertEqual(len(used), 1)
        self.assertEqual([banned for uid, banned in fake.ban_transitions if uid == editor], [True, False, True])
        encoded = json.dumps(result)
        for uid, user in fake.users.items():
            self.assertNotIn(uid, encoded)
            self.assertNotIn(user['email'], encoded)
        for token in fake.tokens:
            self.assertNotIn(token, encoded)

    def test_wrong_permission_error_fails_but_all_registered_fixtures_are_contained(self):
        for fault in ('upload-missing', 'jwt-denial'):
            fake = FakeServices(fault)
            result = c.run(config(), fake, fake)
            self.assertEqual(result['status'], 'failed_or_incomplete')
            self.assertGreater(result['failed'], 0)
            self.assertEqual(set(fake.contained), set(c.ROLES))
            self.assertEqual(fake.sessions, set())
            self.assertEqual(fake.roles, {})
            self.assertFalse(result['cleanup_unconfirmed'])

    def test_lost_password_response_and_admin_get_failure_still_contain_unknown_session(self):
        fake = FakeServices('lost-token-and-admin-get')
        result = c.run(config(), fake, fake)
        self.assertEqual(result['status'], 'failed_or_incomplete')
        self.assertEqual(fake.contained, ['admin'])
        self.assertEqual(fake.sessions, set())
        self.assertEqual(result['cleanup'][0]['role_and_session_cleanup'], 'confirmed')
        self.assertEqual(result['cleanup'][0]['api_logout'], 'no_observed_session')
        self.assertNotEqual(result['cleanup'][0]['auth_ban'], 'confirmed')
        self.assertTrue(result['cleanup_unconfirmed'])
        self.assertNotIn('PRIVATE_', json.dumps(result))

    def test_provider_or_dirty_catalog_failure_stops_before_creating_users(self):
        for fault in ['provider', 'dirty']:
            fake = FakeServices(fault)
            if fault == 'dirty':
                dirty = catalog()
                dirty['auth_users'] = 1
                fake.catalog = lambda: dirty
            result = c.run(config(), fake, fake)
            self.assertEqual(result['status'], 'failed_or_incomplete')
            self.assertEqual(fake.users, {})
            self.assertFalse(any(method == 'POST' for _, _, _, method in fake.requests))
            if fault == 'dirty':
                self.assertFalse(result['guard_preinstalled_in_new_local_stack'])


if __name__ == '__main__':
    unittest.main()
