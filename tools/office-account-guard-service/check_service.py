#!/usr/bin/env python3
"""Fixed NEW local optional-guard HTTP acceptance. Only --run --stdin.

No hosted origin, generic SQL input, existing-project reuse or schema changes.
Auth identities, keys, record bodies and signed URLs remain private in memory.
"""
import base64
import datetime
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time
import uuid
from urllib.parse import urlsplit, parse_qsl

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prep = load_module('account_guard_preparation', Path(__file__).with_name('prepare.py'))
pure = load_module('account_guard_existing_pure_guards', REPO / 'tools/office-current-rehearsal/check_service.py')
# Only stateless validators and the fixed Unix-socket Docker transport are reused.
# The old project globals, run(), SQL methods and inspection methods stay unused.
Refusal, require, safe_error = pure.Refusal, pure.require, pure.safe_error
parse_args, validate_environment = pure.parse_args, pure.validate_environment
fixture_id, jwt_payload = pure.fixture_id, pure.jwt_payload
owned_auth, single, empty, denied = pure.owned_auth, pure.single, pure.empty, pure.denied
validate_auth_settings = pure.validate_auth_settings
PROJECT = 'bcbc-office-account-guard-v1'
ORIGIN = 'http://127.0.0.1:55821'
PORT = 55821
NETWORK = PROJECT + '-loopback'
REVISION = '20260907174301'
ROLES = ('admin', 'editor', 'viewer', 'nonstaff')
VERSIONS = ['20260908220558', '20260908220613', '20260908220623', '20260908220645',
            '20260908220658', '20260908220707', '20260908220718', '20260909024020']
OPTIONAL_SHA = '7530eb7cd955ec1522943a179aebc03088a3ebc8126a4f4300e08eb5695bdc7b'
OPTIONAL_PATH = REPO / 'tools/office-account-guard/migrations/20260909024020_require_eligible_staff_auth_account.sql'
CONTAINERS = {'db': ('5432/tcp', '55822'), 'kong': ('8000/tcp', '55821'),
              'inbucket': ('8025/tcp', '55824'), 'auth': None, 'rest': None, 'storage': None}
IMAGES = {
    'db': 'sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb',
    'storage': 'sha256:105a2584129c9600aebed6f5ac49ca4371c92b996ecd1af7179750333e9e2120',
    'rest': 'sha256:85258123312dc496ad4c2ed832154a65e9746f84df0d6d09b44229ff9230c08e',
    'inbucket': 'sha256:37a38e48e9338cd7e89dfeb487f37b02ebfcd9cb23111bed2d345e79d37d6dd6',
    'auth': 'sha256:c0c25187a6b835e65a6f6e6c6b39d090e832d40e6de5186f2c038e0411944232',
    'kong': 'sha256:1b53405d8680a09d6f44494b7990bf7da2ea43f84a258c59717d4539abf09f6d',
}
APP_TABLES = sorted(('staff_roles events contacts documents audit_log membership_history care_assignments '
                     'care_visits guest_intakes care_guidelines office_announcements committee_contacts '
                     'sunday_slides office_prayer_requests app_connections leader_followups leader_followup_contacts').split())
ORIGINAL = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')


def validate_config(value):
    require(type(value) is dict and set(value) == {'url', 'anonKey', 'serviceKey', 'allowSyntheticWrites'}, 'EXACT_INPUT_FIELDS_REQUIRED')
    require(value['url'] == ORIGIN and value['allowSyntheticWrites'] is True, 'LOCAL_SYNTHETIC_INPUT_REQUIRED')
    jwt_payload(value['anonKey'], 'anon')
    jwt_payload(value['serviceKey'], 'service_role')
    require(value['anonKey'] != value['serviceKey'], 'DISTINCT_KEYS_REQUIRED')
    return dict(value)


def read_config(stream):
    data = stream.read(32769)
    require(len(data) <= 32768, 'INPUT_TOO_LARGE')
    try:
        value = json.loads(data, object_pairs_hook=pure._json_object)
    except Refusal:
        raise
    except Exception:
        raise Refusal('INVALID_INPUT_JSON') from None
    return validate_config(value)


def validate_inspection(data, kind):
    require(kind in CONTAINERS and type(data) is dict and data.get('name') == '/supabase_' + kind + '_' + PROJECT
            and data.get('running') is True and data.get('image') == IMAGES[kind]
            and type(data.get('labels')) is dict and data['labels'].get('com.supabase.cli.project') == PROJECT,
            'CONTAINER_UNVERIFIED')
    require(data.get('network_mode') == NETWORK, 'FIXED_NETWORK_REQUIRED')
    require(type(data.get('ports')) is dict, 'LOOPBACK_BINDING_UNVERIFIED')
    exposed = {k: v for k, v in data['ports'].items() if v is not None}
    binding = CONTAINERS[kind]
    expected = {} if binding is None else {binding[0]: [{'HostIp': '127.0.0.1', 'HostPort': binding[1]}]}
    require(exposed == expected, 'LOOPBACK_BINDING_UNVERIFIED')
    if kind in ('db', 'storage'):
        target = '/var/lib/postgresql/data' if kind == 'db' else '/mnt'
        mounts = data.get('mounts')
        require(type(mounts) is list and len(mounts) == 1 and mounts[0].get('Type') == 'volume'
                and mounts[0].get('Name') == 'supabase_' + kind + '_' + PROJECT
                and mounts[0].get('Destination') == target, 'FIXED_VOLUME_REQUIRED')


class Registry:
    def __init__(self):
        self.run_id = str(uuid.uuid4())
        self.users = {}
        self.contact_id, self.document_id, self.blocked_id = (str(uuid.uuid4()) for _ in range(3))

    def register(self, role):
        require(role in ROLES and role not in self.users, 'INVALID_FIXTURE_ROLE')
        user = {'id': str(uuid.uuid4()), 'email': 'guard-' + self.run_id + '-' + role + '@office-account-guard.invalid', 'token': None}
        self.users[role] = user
        return self.owned(role)

    def owned(self, role):
        require(role in ROLES and role in self.users, 'UNREGISTERED_FIXTURE_REFUSED')
        fixture_id(self.run_id)
        ids = [self.run_id, self.contact_id, self.document_id, self.blocked_id] + [u['id'] for u in self.users.values()]
        for value in ids:
            fixture_id(value)
        require(len(set(ids)) == len(ids), 'DUPLICATE_FIXTURE_ID')
        user = self.users[role]
        require(user['email'] == 'guard-' + self.run_id + '-' + role + '@office-account-guard.invalid', 'NON_SYNTHETIC_IDENTITY_REFUSED')
        return user

    def object_path(self, role='editor', probe=False):
        return self.owned(role)['id'] + '/account-guard/' + (self.blocked_id if probe else self.document_id) + '.png'


def fixture_statement(registry, action, role):
    require(action in ('assign', 'revoke', 'contain'), 'FIXED_FIXTURE_OPERATION_REQUIRED')
    user = registry.owned(role)
    require(action != 'assign' or role in ROLES[:3], 'STAFF_FIXTURE_ROLE_REQUIRED')
    check = "id='" + user['id'] + "'::uuid and email='" + user['email'] + "'"
    if action == 'assign':
        mutation = """if not exists(select 1 from auth.users where """ + check + """ and email_confirmed_at is not null and is_anonymous is false and deleted_at is null and (banned_until is null or banned_until<=now())) then raise exception 'FIXTURE_NOT_ELIGIBLE'; end if;
insert into public.staff_roles(user_id,role) values ('""" + user['id'] + "'::uuid,'" + role + "'::public.staff_role);"
        result = "select json_build_object('role',role) from public.staff_roles where user_id='" + user['id'] + "'::uuid;"
    else:
        mutation = "delete from public.staff_roles where user_id='" + user['id'] + "'::uuid;"
        if action == 'contain':
            mutation += "\ndelete from auth.refresh_tokens where user_id='" + user['id'] + "';\ndelete from auth.sessions where user_id='" + user['id'] + "'::uuid;"
        result = "select json_build_object('roles',(select count(*) from public.staff_roles where user_id='" + user['id'] + "'::uuid)"
        if action == 'contain':
            result += ",'sessions',(select count(*) from auth.sessions where user_id='" + user['id'] + "'::uuid),'refresh_tokens',(select count(*) from auth.refresh_tokens where user_id='" + user['id'] + "')"
        result += ');'
    return "begin;\ndo $fixture$ begin\nperform 1 from auth.users where " + check + " for update;\nif not found then raise exception 'FIXTURE_IDENTITY_MISMATCH'; end if;\n" + mutation + '\nend $fixture$;\n' + result + '\ncommit;\n'


_counts = ','.join("'" + table + "',(select count(*) from public." + table + ')' for table in APP_TABLES)
CATALOG_SQL = """begin read only;
select json_build_object(
 'versions',(select json_agg(version order by version) from supabase_migrations.schema_migrations),
 'public_tables',(select json_agg(tablename order by tablename) from pg_tables where schemaname='public'),
 'rls_tables',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity),
 'policies',(select count(*) from pg_policies where schemaname='public' or (schemaname='storage' and tablename='objects')),
 'functions',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')),
 'guard',(select json_build_object('body',p.prosrc,'definer',p.prosecdef,'stable',p.provolatile='s','return_type',p.prorettype='public.staff_role'::regtype,'settings',p.proconfig,'owner',pg_get_userbyid(p.proowner),'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),'public_execute',exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='current_staff_role' and p.pronargs=0),
 'counts',json_build_object(""" + _counts + """),
 'auth_users',(select count(*) from auth.users),'identities',(select count(*) from auth.identities),
 'sessions',(select count(*) from auth.sessions),'refresh_tokens',(select count(*) from auth.refresh_tokens),
 'confirmed_users',(select count(*) from auth.users where email_confirmed_at is not null and is_anonymous is false and deleted_at is null),
 'banned_users',(select count(*) from auth.users where banned_until>now()),
 'objects',(select count(*) from storage.objects),
 'buckets',(select json_agg(json_build_object('id',id,'name',name,'public',public,'file_size_limit',file_size_limit) order by id) from storage.buckets),
 'intake_entrypoints',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname='save_app_connection' and oidvectortypes(p.proargtypes)='text, text, text, text, boolean, text'),
 'intake_access',(select bool_or(has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname='save_app_connection' and oidvectortypes(p.proargtypes)='text, text, text, text, boolean, text')
);commit;
"""
CONTENT_SQL = 'begin read only;\nselect json_build_object(' + ','.join(
    "'" + table + "',(select coalesce(json_agg(r order by to_jsonb(r)::text),'[]') from public." + table + ' r)'
    for table in APP_TABLES if table != 'staff_roles') + ",'objects',(select coalesce(json_agg(r order by to_jsonb(r)::text),'[]') from storage.objects r));\ncommit;\n"


def expected_guard_body():
    payload = OPTIONAL_PATH.read_bytes()
    require(prep.sha(payload) == OPTIONAL_SHA, 'OPTIONAL_GUARD_SOURCE_CHANGED')
    return re.search(r'as \$\$([\s\S]*?)\$\$;', payload.decode()).group(1)


def validate_catalog(data, virgin=False, final=False):
    numeric = ('rls_tables', 'policies', 'functions', 'intake_entrypoints', 'auth_users', 'identities',
               'sessions', 'refresh_tokens', 'confirmed_users', 'banned_users', 'objects')
    require(type(data) is dict and all(type(data.get(key)) is int and data[key] >= 0 for key in numeric), 'CATALOG_COUNTS_UNCONFIRMED')
    require(data.get('versions') == VERSIONS and data.get('public_tables') == APP_TABLES
            and data.get('rls_tables') == 17 and data.get('policies') == 54 and data.get('functions') == 27, 'EIGHT_MIGRATION_CATALOG_MISMATCH')
    expected = {'body': expected_guard_body(), 'definer': True, 'stable': True, 'return_type': True,
                'settings': ['search_path=""'], 'owner': 'postgres', 'anon_execute': False,
                'authenticated_execute': True, 'public_execute': False}
    require(data.get('guard') == expected and all(type(data['guard'][k]) is type(v) for k, v in expected.items()), 'EXACT_ACCOUNT_GUARD_UNCONFIRMED')
    counts = data.get('counts')
    require(type(counts) is dict and set(counts) == set(APP_TABLES)
            and all(type(v) is int and v >= 0 for v in counts.values()), 'APP_COUNTS_UNCONFIRMED')
    require(data.get('intake_entrypoints') == 2 and data.get('intake_access') is False
            and counts['app_connections'] == counts['guest_intakes'] == 0, 'PUBLIC_INTAKE_NOT_PAUSED')
    require(data.get('buckets') == [{'id': 'church-documents', 'name': 'church-documents', 'public': False, 'file_size_limit': 52428800}], 'PRIVATE_BUCKET_UNCONFIRMED')
    if virgin:
        require(all(v == 0 for v in counts.values()) and all(data.get(k) == 0 for k in
                ['auth_users', 'identities', 'sessions', 'refresh_tokens', 'confirmed_users', 'banned_users', 'objects']), 'VIRGIN_STACK_REQUIRED')
    if final:
        expected_counts = {table: 0 for table in APP_TABLES}
        expected_counts.update(contacts=1, documents=1, audit_log=3)
        require(counts == expected_counts and all(data.get(k) == 4 for k in ['auth_users', 'identities', 'confirmed_users', 'banned_users'])
                and data.get('sessions') == data.get('refresh_tokens') == 0 and data.get('objects') == 1, 'FINAL_CONTAINMENT_UNCONFIRMED')


class LocalStack:
    # This transport has no project selection; its socket/config/command env are fixed.
    _docker = pure.LocalStack._docker

    def verify(self):
        try:
            require(prep.PROJECT == PROJECT and prep.PORTS['api'] == PORT, 'PREPARER_TARGET_MISMATCH')
            prep.verify_prepared_source()
            pure.validate_socket(os.lstat(pure.SOCKET), os.path.realpath(pure.SOCKET), os.getuid())
        except Refusal:
            raise
        except Exception:
            raise Refusal('PRIVATE_SOURCE_OR_SOCKET_UNVERIFIED') from None
        fmt = '{"name":{{json .Name}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}},"ports":{{json .NetworkSettings.Ports}},"network_mode":{{json .HostConfig.NetworkMode}},"image":{{json .Image}},"mounts":{{json .Mounts}}}'
        for kind in CONTAINERS:
            try:
                value = json.loads(self._docker(['inspect', '--format', fmt, 'supabase_' + kind + '_' + PROJECT]))
            except Refusal:
                raise
            except Exception:
                raise Refusal('CONTAINER_INSPECTION_INVALID') from None
            validate_inspection(value, kind)

    def _sql(self, statement):
        self.verify()
        output = self._docker(['exec', '-i', 'supabase_db_' + PROJECT, 'psql', '-X', '--no-password',
            '--username=postgres', '--dbname=postgres', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=sqlstate',
            '--tuples-only', '--no-align', '--quiet'], statement)
        try:
            return json.loads(output)
        except Exception:
            raise Refusal('FIXED_SQL_RESULT_UNCONFIRMED') from None

    def catalog(self):
        return self._sql(CATALOG_SQL)

    def content(self):
        return self._sql(CONTENT_SQL)

    def fixture(self, registry, action, role):
        expected = {'role': role} if action == 'assign' else {'roles': 0, 'sessions': 0, 'refresh_tokens': 0} if action == 'contain' else {'roles': 0}
        require(self._sql(fixture_statement(registry, action, role)) == expected, 'FIXTURE_CHANGE_UNCONFIRMED')


def signed_path(value, object_path):
    require(isinstance(value, str) and len(value) < 16384 and not re.search(r'[\s\\]', value), 'UNSAFE_SIGNED_URL')
    if value.startswith('/object/sign/'):
        value = ORIGIN + '/storage/v1' + value
    elif value.startswith('/storage/v1/object/sign/'):
        value = ORIGIN + value
    parsed = urlsplit(value)
    require(parsed.scheme + '://' + parsed.netloc == ORIGIN and not parsed.username and not parsed.password and not parsed.fragment,
            'UNSAFE_SIGNED_URL')
    require(parsed.path == '/storage/v1/object/sign/church-documents/' + object_path, 'UNSAFE_SIGNED_URL')
    query = parse_qsl(parsed.query, keep_blank_values=True)
    require(len(query) == 1 and query[0][0] == 'token' and re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', query[0][1]), 'UNSAFE_SIGNED_URL')
    return parsed.path + '?' + parsed.query


class LocalApi:
    def __init__(self, config, stack):
        self.config, self.stack = validate_config(config), stack
        self.last = None

    def request(self, path, actor='anon', token=None, method='GET', body=None, binary=False):
        require(isinstance(path, str) and re.fullmatch(r'/(?:auth|rest|storage)/v1/[A-Za-z0-9_/?=&.,*-]+', path)
                and '..' not in path and '//' not in path, 'FIXED_LOCAL_PATH_REQUIRED')
        require(actor in ('anon', 'service', 'user', 'none') and method in ('GET', 'POST', 'PUT', 'PATCH'), 'FIXED_HTTP_OPERATION_REQUIRED')
        self.stack.verify()
        headers = {'Prefer': 'return=representation'}
        if actor != 'none':
            key = self.config['serviceKey' if actor == 'service' else 'anonKey']
            if actor == 'user':
                require(isinstance(token, str) and 20 <= len(token) <= 16384 and not re.search(r'\s', token), 'SESSION_TOKEN_REQUIRED')
            headers.update(apikey=key, Authorization='Bearer ' + (token if actor == 'user' else key))
        else:
            require(method == 'GET' and body is None and path.startswith('/storage/v1/object/'), 'UNAUTHENTICATED_OPERATION_REFUSED')
        if type(body) is bytes:
            require(body == ORIGINAL and actor == 'user' and method == 'POST' and path.startswith('/storage/v1/object/church-documents/'), 'FIXED_ORIGINAL_UPLOAD_REQUIRED')
            encoded = body
            headers.update({'Content-Type': 'image/png', 'x-upsert': 'false'})
        else:
            encoded = json.dumps(body).encode() if body is not None else None
            if encoded is not None:
                require(len(encoded) <= 32768, 'REQUEST_TOO_LARGE')
                headers['Content-Type'] = 'application/json'
        connection = http.client.HTTPConnection('127.0.0.1', PORT, timeout=15)
        try:
            connection.request(method, path, body=encoded, headers=headers)
            response = connection.getresponse()
            require(not 300 <= response.status < 400, 'REDIRECT_REFUSED')
            raw = response.read(1048577)
            require(len(raw) <= 1048576, 'RESPONSE_TOO_LARGE')
            if binary:
                data = raw
            else:
                try:
                    data = json.loads(raw) if raw else None
                except Exception:
                    raise Refusal('JSON_HTTP_RESPONSE_REQUIRED') from None
            self.last = {'status': response.status, 'data': data}
            return self.last
        except Refusal:
            raise
        except Exception:
            raise Refusal('LOCAL_HTTP_UNCONFIRMED') from None
        finally:
            connection.close()


def storage_denied(response, existing_object=False):
    require(response.get('status') in (400, 401, 403, 404), 'STORAGE_PERMISSION_DENIAL_UNCONFIRMED')
    data = response.get('data')
    if type(data) is bytes:
        try:
            data = json.loads(data)
        except Exception:
            raise Refusal('STORAGE_PERMISSION_DENIAL_UNCONFIRMED') from None
    # No generic HTTP failure, invalid token, database exception or missing bucket
    # is counted. NoSuchKey is allowed only with same-object positive controls.
    allowed = ('AccessDenied', 'NoSuchKey') if existing_object else ('AccessDenied',)
    require(type(data) is dict and data.get('code') in allowed, 'STORAGE_PERMISSION_DENIAL_UNCONFIRMED')



def public_private_bucket_hidden(response):
    """Only the public route: private bucket/catalog and owned bytes are controls."""
    data = response.get('data')
    if type(data) is bytes:
        try:
            data = json.loads(data)
        except Exception:
            raise Refusal('PUBLIC_PRIVATE_BUCKET_HIDING_UNCONFIRMED') from None
    if type(data) is dict and data.get('code') == 'NoSuchBucket':
        require(response.get('status') in (400, 404), 'PUBLIC_PRIVATE_BUCKET_HIDING_UNCONFIRMED')
    else:
        storage_denied(response, existing_object=True)


def confirmed_download(response):
    require(response.get('status') == 200 and response.get('data') == ORIGINAL, 'ORIGINAL_BYTES_UNCONFIRMED')


def ban_until(user, banned):
    value = user.get('banned_until')
    if not value:
        require(not banned, 'BAN_STATE_UNCONFIRMED')
        return
    try:
        instant = datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except Exception:
        raise Refusal('BAN_STATE_UNCONFIRMED') from None
    require((instant > time.time()) is banned, 'BAN_STATE_UNCONFIRMED')


def run(config, stack=None, api=None):
    config = validate_config(config)
    stack = stack or LocalStack()
    api = api or LocalApi(config, stack)
    registry = Registry()
    report = {'kind': 'optional-account-guard-local-http', 'project': PROJECT, 'checks': [], 'cleanup': [],
              'hosted_calls': False, 'guard_applied_by_checker': False, 'guard_preinstalled_in_new_local_stack': False,
              'actual_http_pre_guard_reproduction': False, 'signed_url_revocation_claimed': False,
              'limits': ['Local real-service eligibility checks only; not hosted, email, browser, phone or recovery acceptance.',
                         'The optional guard was present from startup; historical pre-guard reproduction is PGlite only.',
                         'Previously issued signed URLs remain bearer links until expiry; this is not global JWT/session revocation.',
                         'Confirmed fictional accounts and records remain; a failed or interrupted run must never be blindly repeated.']}
    content = None

    def mark(name):
        report['checks'].append({'check': name, 'status': 'passed'})

    def user_request(role, path, method='GET', body=None, binary=False):
        return api.request(path, 'user', registry.owned(role)['token'], method, body, binary=binary)

    def readiness(role):
        value = user_request(role, '/rest/v1/rpc/office_readiness', 'POST', {})
        require(value['status'] == 200 and type(value['data']) is dict and value['data'].get('schema_revision') == REVISION
                and value['data'].get('staff_role') == role, 'STAFF_READINESS_UNCONFIRMED')

    def contact_read(role, visible):
        value = user_request(role, '/rest/v1/contacts?select=id&id=eq.' + registry.contact_id)
        if visible:
            require(single(value).get('id') == registry.contact_id, 'CONTACT_READ_UNCONFIRMED')
        else:
            empty(value)

    def sign(role):
        value = user_request(role, '/storage/v1/object/sign/church-documents/' + registry.object_path(), 'POST', {'expiresIn': 300})
        require(value['status'] == 200 and type(value['data']) is dict, 'SIGNED_URL_CREATE_UNCONFIRMED')
        return signed_path(value['data'].get('signedURL'), registry.object_path())

    def positive(role):
        readiness(role)
        contact_read(role, True)
        confirmed_download(user_request(role, '/storage/v1/object/authenticated/church-documents/' + registry.object_path(), binary=True))

    def blocked(role, own_role):
        contact_read(role, False)
        denied(user_request(role, '/rest/v1/rpc/office_readiness', 'POST', {}))
        denied(user_request(role, '/rest/v1/contacts?select=id', 'POST', {'id': registry.blocked_id, 'first_name': 'Fictional', 'last_name': 'Blocked'}))
        storage_denied(user_request(role, '/storage/v1/object/authenticated/church-documents/' + registry.object_path(), binary=True), existing_object=True)
        storage_denied(user_request(role, '/storage/v1/object/church-documents/' + registry.object_path(role, True), 'POST', ORIGINAL))
        storage_denied(user_request(role, '/storage/v1/object/sign/church-documents/' + registry.object_path(), 'POST', {'expiresIn': 300}), existing_object=True)
        value = user_request(role, '/rest/v1/staff_roles?select=user_id,role&user_id=eq.' + registry.owned(role)['id'])
        if own_role:
            require(single(value) == {'user_id': registry.owned(role)['id'], 'role': role}, 'VALID_TOKEN_OWN_ROLE_CONTROL_UNCONFIRMED')
        else:
            empty(value)
        require(stack.content() == content, 'DENIED_OPERATIONS_CHANGED_CONTENT')
        positive('admin')

    def change_ban(role, banned):
        user = registry.owned(role)
        owned_auth(api.request('/auth/v1/admin/users/' + user['id'], 'service'), user)
        response = api.request('/auth/v1/admin/users/' + user['id'], 'service', method='PUT', body={'ban_duration': '87600h' if banned else 'none'})
        ban_until(owned_auth(response, user), banned)
        ban_until(owned_auth(api.request('/auth/v1/admin/users/' + user['id'], 'service'), user), banned)

    try:
        validate_catalog(stack.catalog(), virgin=True)
        report['guard_preinstalled_in_new_local_stack'] = True
        validate_auth_settings(api.request('/auth/v1/settings'))
        mark('virgin exact-eight local stack and current account guard verified')
        for role in ROLES:
            user = registry.register(role)
            password = secrets.token_urlsafe(48)
            created = owned_auth(api.request('/auth/v1/admin/users', 'service', method='POST', body={
                'id': user['id'], 'email': user['email'], 'password': password, 'email_confirm': True,
                'user_metadata': {'synthetic': True}}), user)
            require(created.get('email_confirmed_at') and created.get('is_anonymous') is False, 'CONFIRMED_FIXTURE_REQUIRED')
            response = api.request('/auth/v1/token?grant_type=password', method='POST', body={'email': user['email'], 'password': password})
            password = None
            owned_auth(response, user)
            user['token'] = response['data'].get('access_token')
            claims = jwt_payload(user['token'], 'authenticated')
            require(claims.get('sub') == user['id'] and type(claims.get('exp')) is int and claims['exp'] > time.time() + 300, 'LIVE_FIXTURE_TOKEN_UNCONFIRMED')
            if role != 'nonstaff':
                stack.fixture(registry, 'assign', role)
        for role in ROLES[:3]:
            readiness(role)
        denied(user_request('nonstaff', '/rest/v1/rpc/office_readiness', 'POST', {}))
        denied(api.request('/rest/v1/rpc/office_readiness', method='POST', body={}))
        mark('four confirmed fictional password sessions and staff role controls')
        contact = single(user_request('admin', '/rest/v1/contacts?select=*', 'POST', {'id': registry.contact_id, 'first_name': 'Fictional', 'last_name': 'Account Guard', 'status': 'visitor'}))
        require(contact.get('id') == registry.contact_id and contact.get('version') == 1, 'CONTACT_CREATION_UNCONFIRMED')
        contact = single(user_request('editor', '/rest/v1/contacts?select=*&id=eq.' + registry.contact_id + '&version=eq.1', 'PATCH', {'notes': 'Fictional guard acceptance record.'}))
        require(contact.get('id') == registry.contact_id and contact.get('version') == 2 and contact.get('notes') == 'Fictional guard acceptance record.', 'EDITOR_UPDATE_UNCONFIRMED')
        uploaded = user_request('editor', '/storage/v1/object/church-documents/' + registry.object_path(), 'POST', ORIGINAL)
        require(uploaded['status'] in (200, 201) and type(uploaded['data']) is dict, 'ORIGINAL_UPLOAD_UNCONFIRMED')
        document = single(user_request('editor', '/rest/v1/documents?select=*', 'POST', {'id': registry.document_id, 'title': 'Fictional account guard original',
            'category': 'other', 'storage_path': registry.object_path(), 'file_name': 'fictional-account-guard.png', 'mime_type': 'image/png',
            'size_bytes': len(ORIGINAL), 'uploaded_by': registry.owned('editor')['id']}))
        require(document.get('id') == registry.document_id and document.get('version') == 1, 'DOCUMENT_CREATION_UNCONFIRMED')
        for role in ROLES[:3]:
            positive(role)
        content = stack.content()
        for role in ('viewer', 'nonstaff'):
            denied(user_request(role, '/rest/v1/contacts?select=id', 'POST', {'id': registry.blocked_id, 'first_name': 'Fictional', 'last_name': 'Blocked'}))
            storage_denied(user_request(role, '/storage/v1/object/church-documents/' + registry.object_path(role, True), 'POST', ORIGINAL))
        blocked('nonstaff', False)
        public_private_bucket_hidden(api.request('/storage/v1/object/public/church-documents/' + registry.object_path(), 'none', binary=True))
        positive('editor')
        mark('real private original and editor write controls with viewer and nonstaff denial')
        retained_token = registry.owned('editor')['token']
        issued = sign('editor')
        confirmed_download(api.request(issued, 'none', binary=True))
        change_ban('editor', True)
        require(registry.owned('editor')['token'] == retained_token, 'EXISTING_TOKEN_CHANGED')
        blocked('editor', True)
        confirmed_download(api.request(issued, 'none', binary=True))
        mark('ban denies existing-token office operations while earlier signed bearer link remains usable')
        change_ban('editor', False)
        require(registry.owned('editor')['token'] == retained_token, 'EXISTING_TOKEN_CHANGED')
        positive('editor')
        confirmed_download(api.request(sign('editor'), 'none', binary=True))
        mark('unban restores existing-token readiness reads and new signing')
        stack.fixture(registry, 'revoke', 'editor')
        require(registry.owned('editor')['token'] == retained_token, 'EXISTING_TOKEN_CHANGED')
        blocked('editor', False)
        mark('same-token role removal denies protected record and Storage operations')
        denied(user_request('admin', '/rest/v1/rpc/save_app_connection', 'POST', {'p_first_name': 'Fictional', 'p_last_name': 'Blocked', 'p_phone': None,
            'p_preferred_contact': 'email', 'p_contact_permission': True, 'p_sunday_school': None}))
        validate_catalog(stack.catalog())
        require(stack.content() == content, 'CONTENT_CHANGED_AFTER_GUARD_CHECKS')
        mark('public intake remains paused and denied attempts leave retained content unchanged')
    except Exception as error:
        report['checks'].append({'check': 'account guard HTTP matrix', 'status': 'failed', 'error': safe_error(error)})
    finally:
        for role in ROLES:
            if role not in registry.users:
                continue
            action = {'fixture_role': role}
            report['cleanup'].append(action)
            try:
                user = registry.owned(role)
                if user['token']:
                    try:
                        result = user_request(role, '/auth/v1/logout?scope=global', 'POST')
                        require(200 <= result['status'] < 300, 'LOGOUT_UNCONFIRMED')
                        action['api_logout'] = 'confirmed'
                    except Exception as error:
                        action['api_logout'] = safe_error(error)
                else:
                    action['api_logout'] = 'no_observed_session'
                # SQL independently locks and verifies this exact registered ID/email.
                # A failed Admin GET must not prevent containing a lost-response session.
                try:
                    stack.fixture(registry, 'contain', role)
                    action['role_and_session_cleanup'] = 'confirmed'
                except Exception as error:
                    action['role_and_session_cleanup'] = safe_error(error)
                try:
                    change_ban(role, True)
                    action['auth_ban'] = 'confirmed'
                except Exception as error:
                    action['auth_ban'] = safe_error(error)
            except Exception as error:
                action['owned_identity'] = safe_error(error)
            finally:
                registry.users[role]['token'] = None
        try:
            validate_catalog(stack.catalog(), final=True)
            require(content is not None and stack.content() == content, 'FINAL_CONTENT_UNCONFIRMED')
            mark('all four fixtures contained with zero roles sessions and intake')
            report['final_counts'] = {'auth_users': 4, 'banned_users': 4, 'staff_roles': 0, 'sessions': 0, 'refresh_tokens': 0,
                                      'contacts': 1, 'documents': 1, 'objects': 1, 'audit_rows': 3, 'app_connections': 0}
        except Exception as error:
            report['checks'].append({'check': 'final containment', 'status': 'failed', 'error': safe_error(error)})
    report['passed'] = sum(row['status'] == 'passed' for row in report['checks'])
    report['failed'] = sum(row['status'] == 'failed' for row in report['checks'])
    report['cleanup_unconfirmed'] = len(report['cleanup']) != 4 or any(row.get('role_and_session_cleanup') != 'confirmed' or row.get('auth_ban') != 'confirmed' for row in report['cleanup'])
    report['status'] = 'passed_local_guard_http_only' if not report['failed'] and not report['cleanup_unconfirmed'] else 'failed_or_incomplete'
    return report


def main():
    try:
        parse_args(sys.argv[1:])
        validate_environment(os.environ)
        require(not sys.stdin.isatty(), 'PIPE_JSON_INPUT_REQUIRED')
        report = run(read_config(sys.stdin.buffer))
        print(json.dumps(report, indent=2))
        return 0 if report['status'] == 'passed_local_guard_http_only' else 1
    except Exception as error:
        print(json.dumps({'status': 'refused_or_failed', 'error': safe_error(error)}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
