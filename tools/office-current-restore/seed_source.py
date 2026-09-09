#!/usr/bin/env python3
"""Seed one fixed NEW local recovery source with fictional data. Never hosted.

Only CLI: --run --stdin. Keys, passwords, UUIDs, original names and SQL/API
results remain in memory. Final output contains fixed checks and counts only.
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

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prep = _load('fixed_recovery_source_preparer', Path(__file__).with_name('prepare_source.py'))
c = _load('fixed_recovery_service_guards', REPO / 'tools/office-current-rehearsal/check_service.py')
PROJECT = prep.PROJECT
NETWORK = 'bcbc-office-recovery-source-v1-loopback'
ORIGIN = 'http://127.0.0.1:55621'
PORT = 55621
VERSIONS = [name[:14] for name, _ in prep.MIGRATIONS]
REVISION = '20260907174301'
CONTAINERS = {'db': ('5432/tcp', '55622'), 'kong': ('8000/tcp', '55621'),
              'inbucket': ('8025/tcp', '55624'), 'auth': None, 'rest': None, 'storage': None}
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
MIME = 'image/png'
FILE_NAME = 'fictional-recovery-original.png'
DOC_TITLE = 'Fictional recovery source'
EVENT_TYPE = 'Recovery fixture'
DATE_TEXT = 'Synthetic date; not a church record'
SOURCE_LABEL = 'Fictional recovery page'
DETAILS = 'Fictional source retained for local restore verification.'

# Configure only this independently loaded helper instance. The preserved source
# file and its separately running 555xx stack are never changed or targeted.
c.PROJECT, c.ORIGIN = PROJECT, ORIGIN
Refusal, require, safe_error = c.Refusal, c.require, c.safe_error
parse_args, validate_environment = c.parse_args, c.validate_environment
read_config, validate_config, fixture_id = c.read_config, c.validate_config, c.fixture_id
single, owned_auth, validate_auth_settings = c.single, c.owned_auth, c.validate_auth_settings


def validate_inspection(data, kind):
    require(kind in CONTAINERS and type(data) is dict, 'CONTAINER_UNVERIFIED')
    require(data.get('name') == '/supabase_' + kind + '_' + PROJECT and data.get('running') is True
            and type(data.get('labels')) is dict and data['labels'].get('com.supabase.cli.project') == PROJECT
            and data.get('image') == IMAGES[kind], 'CONTAINER_UNVERIFIED')
    require(data.get('network_mode') == NETWORK, 'FIXED_NETWORK_REQUIRED')
    ports = data.get('ports')
    require(type(ports) is dict, 'LOOPBACK_BINDING_UNVERIFIED')
    exposed = {name: value for name, value in ports.items() if value is not None}
    binding = CONTAINERS[kind]
    expected = {} if binding is None else {binding[0]: [{'HostIp': '127.0.0.1', 'HostPort': binding[1]}]}
    require(exposed == expected, 'LOOPBACK_BINDING_UNVERIFIED')
    if kind in ('db', 'storage'):
        mounts = data.get('mounts')
        target = '/var/lib/postgresql/data' if kind == 'db' else '/mnt'
        require(type(mounts) is list and len(mounts) == 1 and mounts[0].get('Type') == 'volume'
                and mounts[0].get('Name') == 'supabase_' + kind + '_' + PROJECT
                and mounts[0].get('Destination') == target, 'FIXED_VOLUME_REQUIRED')


_counts = ','.join("'" + table + "',(select count(*) from public." + table + ')' for table in APP_TABLES)
CATALOG_SQL = """begin read only;
select json_build_object(
  'versions', (select json_agg(version order by version) from supabase_migrations.schema_migrations),
  'public_tables', (select json_agg(tablename order by tablename) from pg_tables where schemaname='public'),
  'rls_tables', (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity),
  'policies', (select count(*) from pg_policies where schemaname='public' or (schemaname='storage' and tablename='objects')),
  'functions', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')),
  'counts', json_build_object(""" + _counts + """),
  'auth_users', (select count(*) from auth.users),
  'auth_identities', (select count(*) from auth.identities),
  'auth_sessions', (select count(*) from auth.sessions),
  'active_refresh_tokens', (select count(*) from auth.refresh_tokens where not coalesce(revoked,false)),
  'confirmed_users', (select count(*) from auth.users where email_confirmed_at is not null and is_anonymous is false and deleted_at is null),
  'banned_users', (select count(*) from auth.users where banned_until > now()),
  'objects', (select count(*) from storage.objects),
  'buckets', (select json_agg(json_build_object('id',id,'name',name,'public',public,'file_size_limit',file_size_limit) order by id) from storage.buckets),
  'intake_entrypoints', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname='save_app_connection' and oidvectortypes(p.proargtypes)='text, text, text, text, boolean, text'),
  'intake_grants', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where n.nspname in ('public','private') and p.proname='save_app_connection' and a.privilege_type='EXECUTE' and (a.grantee=0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated'))))
);
commit;
"""


def validate_catalog(data, virgin=False, final=False):
    require(type(data) is dict and data.get('versions') == VERSIONS and data.get('public_tables') == APP_TABLES
            and data.get('rls_tables') == 17 and data.get('policies') == 54 and data.get('functions') == 27,
            'CURRENT_BASELINE_CATALOG_MISMATCH')
    counts = data.get('counts')
    require(type(counts) is dict and set(counts) == set(APP_TABLES)
            and all(type(value) is int and value >= 0 for value in counts.values()), 'APP_COUNTS_UNCONFIRMED')
    require(data.get('intake_entrypoints') == 2 and data.get('intake_grants') == 0
            and counts['app_connections'] == 0 and counts['guest_intakes'] == 0, 'PUBLIC_INTAKE_NOT_PAUSED')
    require(data.get('buckets') == [{'id': 'church-documents', 'name': 'church-documents', 'public': False, 'file_size_limit': 52428800}], 'PRIVATE_BUCKET_UNCONFIRMED')
    if virgin:
        require(all(value == 0 for value in counts.values()) and all(data.get(key) == 0 for key in
                ['auth_users', 'auth_identities', 'auth_sessions', 'active_refresh_tokens', 'objects', 'confirmed_users', 'banned_users']), 'VIRGIN_SOURCE_REQUIRED')
    if final:
        expected = {table: 0 for table in APP_TABLES}
        expected.update({'contacts': 1, 'documents': 1, 'membership_history': 1, 'audit_log': 3})
        require(counts == expected and data.get('auth_users') == data.get('auth_identities') == data.get('confirmed_users') == data.get('banned_users') == data.get('objects') == 1
                and data.get('auth_sessions') == data.get('active_refresh_tokens') == 0, 'FINAL_SOURCE_CONTAINMENT_UNCONFIRMED')


class Fixture:
    def __init__(self):
        self.run_id = str(uuid.uuid4())
        self.user = {'id': str(uuid.uuid4()), 'email': 'recovery-' + self.run_id + '@office-current-recovery.invalid', 'token': None}
        self.contact_id, self.document_id, self.history_id = (str(uuid.uuid4()) for _ in range(3))
        self.attempted = False

    def owned(self):
        fixture_id(self.run_id)
        for value in [self.user['id'], self.contact_id, self.document_id, self.history_id]:
            fixture_id(value)
        require(len({self.run_id, self.user['id'], self.contact_id, self.document_id, self.history_id}) == 5, 'DUPLICATE_FIXTURE_ID')
        require(self.user['email'] == 'recovery-' + self.run_id + '@office-current-recovery.invalid', 'SYNTHETIC_IDENTITY_REQUIRED')
        return self.user

    @property
    def path(self):
        return self.owned()['id'] + '/membership-history/' + self.document_id + '.png'


def fixture_statement(fixture, action):
    require(action in ('assign', 'contain'), 'FIXED_FIXTURE_OPERATION_REQUIRED')
    user = fixture.owned()
    # All interpolated data is generated in this run and validated UUID/.invalid.
    check = "id='" + user['id'] + "'::uuid and email='" + user['email'] + "'"
    mutation = ("""if exists(select 1 from public.staff_roles) or not exists(select 1 from auth.users where """ + check + """ and email_confirmed_at is not null and is_anonymous is false and deleted_at is null and (banned_until is null or banned_until <= now())) then raise exception 'FIXTURE_ROLE_REFUSED'; end if;
insert into public.staff_roles(user_id,role) values ('""" + user['id'] + "'::uuid,'editor');"
                if action == 'assign' else "delete from public.staff_roles where user_id='" + user['id'] + "'::uuid;\ndelete from auth.refresh_tokens where user_id='" + user['id'] + "';\ndelete from auth.sessions where user_id='" + user['id'] + "'::uuid;")
    result = ("select json_build_object('role',role) from public.staff_roles where user_id='" + user['id'] + "'::uuid;"
              if action == 'assign' else "select json_build_object('roles',(select count(*) from public.staff_roles where user_id='" + user['id'] + "'::uuid),'sessions',(select count(*) from auth.sessions where user_id='" + user['id'] + "'::uuid),'refresh_tokens',(select count(*) from auth.refresh_tokens where user_id='" + user['id'] + "'));")
    return "begin;\ndo $fixture$ begin\nperform 1 from auth.users where " + check + " for update;\nif not found then raise exception 'FIXTURE_IDENTITY_MISMATCH'; end if;\n" + mutation + '\nend $fixture$;\n' + result + '\ncommit;\n'


def linkage_statement(fixture):
    user = fixture.owned()
    return """begin read only;
select json_build_object('linked',(select count(*) from public.membership_history h
join public.contacts c on c.id=h.contact_id
join public.documents d on d.id=h.source_document_id
join storage.objects o on o.name=d.storage_path and o.bucket_id='church-documents'
join auth.users u on u.id=d.uploaded_by and u.id=h.created_by and u.id=c.created_by
where h.id='""" + fixture.history_id + "' and c.id='" + fixture.contact_id + "' and d.id='" + fixture.document_id + "' and u.id='" + user['id'] + "' and u.email='" + user['email'] + "' and d.storage_path='" + fixture.path + """'
and c.first_name='Fictional' and c.last_name='Recovery Fixture' and c.version=1
and d.title='Fictional recovery source' and d.file_name='fictional-recovery-original.png' and d.mime_type='image/png'
and d.size_bytes=""" + str(len(ORIGINAL)) + """ and d.version=1 and h.event_type='Recovery fixture'
and h.event_date is null and h.date_text='Synthetic date; not a church record'
and h.source_label='Fictional recovery page' and h.details='Fictional source retained for local restore verification.'
and h.corrects_id is null));
commit;
"""


class LocalStack(c.LocalStack):
    def verify(self):
        try:
            prep.verify_prepared_source()
            c.validate_socket(os.lstat(c.SOCKET), os.path.realpath(c.SOCKET), os.getuid())
        except Refusal:
            raise
        except Exception:
            raise Refusal('PRIVATE_SOURCE_OR_SOCKET_UNVERIFIED') from None
        fmt = '{"name":{{json .Name}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}},"ports":{{json .NetworkSettings.Ports}},"network_mode":{{json .HostConfig.NetworkMode}},"image":{{json .Image}},"mounts":{{json .Mounts}}}'
        for kind in CONTAINERS:
            try:
                data = json.loads(self._docker(['inspect', '--format', fmt, 'supabase_' + kind + '_' + PROJECT]))
            except Refusal:
                raise
            except Exception:
                raise Refusal('CONTAINER_INSPECTION_INVALID') from None
            validate_inspection(data, kind)

    def catalog(self):
        return self._sql(CATALOG_SQL)

    def fixture(self, fixture, action):
        result = self._sql(fixture_statement(fixture, action))
        require(result == ({'role': 'editor'} if action == 'assign' else {'roles': 0, 'sessions': 0, 'refresh_tokens': 0}), 'FIXTURE_ACCESS_CHANGE_UNCONFIRMED')

    def linkage(self, fixture):
        require(self._sql(linkage_statement(fixture)) == {'linked': 1}, 'FIXTURE_LINKAGE_UNCONFIRMED')


class LocalApi:
    def __init__(self, config, stack):
        self.config, self.stack = validate_config(config), stack
        self.last = None

    def request(self, path, actor='anon', token=None, method='GET', body=None, binary=False):
        require(isinstance(path, str) and re.fullmatch(r'/(?:auth|rest|storage)/v1/[A-Za-z0-9_/?=&.,*-]+', path)
                and '//' not in path and '..' not in path, 'FIXED_LOCAL_PATH_REQUIRED')
        require(method in ('GET', 'POST', 'PUT') and actor in ('anon', 'service', 'user'), 'FIXED_HTTP_OPERATION_REQUIRED')
        self.stack.verify()  # Fixed topology also precedes every credential-bearing read.
        key = self.config['serviceKey' if actor == 'service' else 'anonKey']
        if actor == 'user':
            require(isinstance(token, str) and 20 <= len(token) <= 16384 and not re.search(r'\s', token), 'SESSION_TOKEN_REQUIRED')
        headers = {'apikey': key, 'Authorization': 'Bearer ' + (token if actor == 'user' else key), 'Prefer': 'return=representation'}
        if type(body) is bytes:
            require(body == ORIGINAL and actor == 'user' and method == 'POST' and path.startswith('/storage/v1/object/church-documents/'), 'FIXED_ORIGINAL_UPLOAD_REQUIRED')
            encoded = body
            headers.update({'Content-Type': MIME, 'x-upsert': 'false'})
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


def storage_denied(response):
    require(response['status'] in (400, 401, 403, 404) and type(response['data']) is bytes,
            'ANONYMOUS_ORIGINAL_NOT_DENIED')
    try:
        data = json.loads(response['data'])
    except Exception:
        raise Refusal('STORAGE_DENIAL_UNCONFIRMED') from None
    require(type(data) is dict and (data.get('code') in ('AccessDenied', 'NoSuchKey', 'NoSuchBucket')
            or data.get('error') in ('Unauthorized', 'Forbidden', 'Not Found')),
            'STORAGE_DENIAL_UNCONFIRMED')


def run(config, stack=None, api=None):
    config = validate_config(config)
    stack = stack or LocalStack()
    api = api or LocalApi(config, stack)
    fixture = Fixture()
    user = fixture.owned()
    report = {'kind': 'current-seven-recovery-source-fixture', 'project': PROJECT, 'checks': [], 'cleanup': {},
              'hosted_calls': False, 'restore_performed': False, 'browser_or_device_acceptance': False,
              'limits': ['Fictional local source only; this does not prove a restored target or off-device recovery.',
                         'Keys, identities, record bodies and object names are omitted from output.',
                         'A failed or interrupted run must be reviewed; never automatically repeat on a nonvirgin source.']}

    def mark(name):
        report['checks'].append({'check': name, 'status': 'passed'})

    def request(path, method='GET', body=None, binary=False):
        return api.request(path, 'user', user['token'], method, body, binary=binary)

    try:
        validate_catalog(stack.catalog(), virgin=True)
        validate_auth_settings(api.request('/auth/v1/settings'))
        mark('fixed virgin seven-migration source and closed-signup email provider')
        password = secrets.token_urlsafe(48)
        fixture.attempted = True
        created = owned_auth(api.request('/auth/v1/admin/users', 'service', method='POST', body={
            'id': user['id'], 'email': user['email'], 'password': password, 'email_confirm': True,
            'user_metadata': {'synthetic': True}}), user)
        require(created.get('email_confirmed_at') and created.get('is_anonymous') is False, 'CONFIRMED_FIXTURE_REQUIRED')
        session = api.request('/auth/v1/token?grant_type=password', method='POST', body={'email': user['email'], 'password': password})
        password = None
        owned_auth(session, user)
        user['token'] = session['data'].get('access_token')
        require(isinstance(user['token'], str) and len(user['token']) >= 20, 'PASSWORD_SESSION_UNCONFIRMED')
        stack.fixture(fixture, 'assign')
        ready = request('/rest/v1/rpc/office_readiness', 'POST', {})
        require(ready['status'] == 200 and type(ready['data']) is dict and ready['data'].get('schema_revision') == REVISION
                and ready['data'].get('staff_role') == 'editor', 'EDITOR_READINESS_UNCONFIRMED')
        mark('one confirmed fictional identity with actual password sign-in and editor readiness')
        contact = single(request('/rest/v1/contacts?select=*', 'POST', {'id': fixture.contact_id, 'first_name': 'Fictional',
            'last_name': 'Recovery Fixture', 'status': 'visitor', 'notes': 'Fictional local recovery fixture.'}))
        require(contact.get('id') == fixture.contact_id and contact.get('version') == 1 and contact.get('created_by') == user['id'], 'CONTACT_CREATION_UNCONFIRMED')
        upload = request('/storage/v1/object/church-documents/' + fixture.path, 'POST', ORIGINAL)
        require(upload['status'] in (200, 201) and type(upload['data']) is dict, 'ORIGINAL_UPLOAD_UNCONFIRMED')
        document = single(request('/rest/v1/documents?select=*', 'POST', {'id': fixture.document_id, 'title': DOC_TITLE,
            'category': 'other', 'description': 'Fictional original for local recovery verification.', 'storage_path': fixture.path,
            'file_name': FILE_NAME, 'mime_type': MIME, 'size_bytes': len(ORIGINAL), 'uploaded_by': user['id']}))
        require(document.get('id') == fixture.document_id and document.get('storage_path') == fixture.path
                and document.get('uploaded_by') == user['id'] and document.get('version') == 1, 'DOCUMENT_CREATION_UNCONFIRMED')
        history = single(request('/rest/v1/membership_history?select=*', 'POST', {'id': fixture.history_id,
            'contact_id': fixture.contact_id, 'source_document_id': fixture.document_id, 'event_type': EVENT_TYPE,
            'date_text': DATE_TEXT, 'source_label': SOURCE_LABEL, 'details': DETAILS}))
        require(history.get('id') == fixture.history_id and history.get('contact_id') == fixture.contact_id
                and history.get('source_document_id') == fixture.document_id and history.get('created_by') == user['id'], 'HISTORY_CREATION_UNCONFIRMED')
        stack.linkage(fixture)
        mark('authenticated contact, source metadata and preserved history link')
        private_path = '/storage/v1/object/authenticated/church-documents/' + fixture.path
        downloaded = request(private_path, binary=True)
        require(downloaded['status'] == 200 and downloaded['data'] == ORIGINAL, 'AUTHORIZED_ORIGINAL_BYTES_MISMATCH')
        storage_denied(api.request(private_path, binary=True))
        storage_denied(api.request('/storage/v1/object/public/church-documents/' + fixture.path, binary=True))
        positive = request(private_path, binary=True)
        require(positive['status'] == 200 and positive['data'] == ORIGINAL, 'ORIGINAL_POSITIVE_CONTROL_FAILED')
        mark('exact authorized original bytes and two anonymous denial controls')
    except Exception as error:
        report['checks'].append({'check': 'source fixture', 'status': 'failed', 'error': safe_error(error)})
    finally:
        if fixture.attempted:
            actions = report['cleanup']
            try:
                owned_auth(api.request('/auth/v1/admin/users/' + user['id'], 'service'), user)
                if user['token']:
                    try:
                        logout = request('/auth/v1/logout?scope=global', 'POST')
                        require(200 <= logout['status'] < 300, 'LOGOUT_UNCONFIRMED')
                        actions['api_logout'] = 'confirmed'
                    except Exception as error:
                        actions['api_logout'] = safe_error(error)
                # Also contains an owned session whose password response was lost.
                try:
                    stack.fixture(fixture, 'contain')
                    actions['role_and_session_cleanup'] = 'confirmed'
                except Exception as error:
                    actions['role_and_session_cleanup'] = safe_error(error)
                try:
                    owned_auth(api.request('/auth/v1/admin/users/' + user['id'], 'service'), user)
                    banned = owned_auth(api.request('/auth/v1/admin/users/' + user['id'], 'service', method='PUT', body={'ban_duration': '87600h'}), user)
                    until = datetime.datetime.fromisoformat(banned.get('banned_until', '').replace('Z', '+00:00'))
                    require(until.timestamp() > time.time(), 'BAN_UNCONFIRMED')
                    actions['auth_ban'] = 'confirmed'
                except Exception as error:
                    actions['auth_ban'] = safe_error(error)
            except Exception as error:
                actions['owned_identity'] = safe_error(error)
            try:
                final = stack.catalog()
                validate_catalog(final, final=True)
                stack.linkage(fixture)
                report['final_counts'] = {'auth_users': 1, 'banned_auth_users': 1, 'staff_roles': 0, 'sessions': 0,
                    'contacts': 1, 'documents': 1, 'history_entries': 1, 'objects': 1, 'app_connections': 0, 'guest_intakes': 0}
                mark('final single linked fixture with zero roles, sessions and intake')
            except Exception as error:
                report['checks'].append({'check': 'final source containment', 'status': 'failed', 'error': safe_error(error)})
        user['token'] = None
    report['passed'] = sum(item['status'] == 'passed' for item in report['checks'])
    report['failed'] = sum(item['status'] == 'failed' for item in report['checks'])
    report['status'] = 'prepared_source_contained' if report['failed'] == 0 and report['cleanup'].get('role_and_session_cleanup') == report['cleanup'].get('auth_ban') == 'confirmed' else 'failed_or_incomplete'
    return report


def main():
    try:
        parse_args(sys.argv[1:])
        validate_environment(os.environ)
        require(not sys.stdin.isatty(), 'PIPE_JSON_INPUT_REQUIRED')
        report = run(read_config(sys.stdin.buffer))
        print(json.dumps(report, indent=2))
        return 0 if report['status'] == 'prepared_source_contained' else 1
    except Exception as error:
        print(json.dumps({'status': 'refused_or_failed', 'error': safe_error(error)}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
