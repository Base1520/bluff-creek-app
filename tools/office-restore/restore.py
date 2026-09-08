#!/usr/bin/env python3
"""One fixed, fictional-data local cold restore drill. No hosted target support."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import http.client
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import stat
import subprocess
import sys
import tarfile
import time
import tomllib
import uuid
from urllib.parse import quote, urlsplit

REPO = Path(__file__).resolve().parents[2]
WORK = REPO.parent
SOURCE = 'bcbc-office-rehearsal'
TARGET = 'bcbc-office-restore-rehearsal'
SOURCE_DIR = WORK / 'office-rehearsal-stack'
DOCKER = '/opt/homebrew/bin/docker'
SOCKET = Path('/private/tmp/bcbc-office-im-x20/colima/office/docker.sock')
HOST = 'unix://' + str(SOCKET)
CLI = WORK / 'tools/supabase/2.117.0/supabase'
CLI_SHA = 'c2ca0770b4634e85a01254ffdfda1999063e5d424f41dc345839e62171d8bb4b'
IMAGES = {
    'db': ('postgres:17.6.1.167', '6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb'),
    'storage': ('storage-api:v1.72.1', '105a2584129c9600aebed6f5ac49ca4371c92b996ecd1af7179750333e9e2120'),
    'rest': ('postgrest:v16.2', '85258123312dc496ad4c2ed832154a65e9746f84df0d6d09b44229ff9230c08e'),
    'inbucket': ('mailpit:v1.30.2', '37a38e48e9338cd7e89dfeb487f37b02ebfcd9cb23111bed2d345e79d37d6dd6'),
    'auth': ('gotrue:v2.196.0', 'c0c25187a6b835e65a6f6e6c6b39d090e832d40e6de5186f2c038e0411944232'),
    'kong': ('kong:2.8.1', '1b53405d8680a09d6f44494b7990bf7da2ea43f84a258c59717d4539abf09f6d'),
}
APP_TABLES = ('staff_roles events contacts documents audit_log membership_history '
              'care_assignments care_visits guest_intakes care_guidelines office_announcements '
              'committee_contacts sunday_slides office_prayer_requests app_connections '
              'leader_followups leader_followup_contacts').split()
TABLES = ['public.' + name for name in APP_TABLES] + [
    'auth.users', 'auth.identities', 'storage.buckets', 'storage.objects',
    'supabase_migrations.schema_migrations']
MIGRATIONS = ['20260907231507', '20260907231527', '20260907231528',
              '20260907231530', '20260907231531', '20260907231533']
MAX_ARCHIVE = 2 * 1024 ** 3
MAX_HTTP = 50 * 1024 ** 2
EXCLUDED = 'realtime,imgproxy,postgres-meta,studio,edge-runtime,logflare,vector,supavisor'


class Refused(Exception):
    """Only fixed, non-sensitive error codes leave the runner."""


def require(condition, code):
    if not condition:
        raise Refused(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def resident_file(path):
    metadata = path.lstat()
    require(stat.S_ISREG(metadata.st_mode) and not getattr(metadata, 'st_flags', 0) & 0x40000000,
            'LOCAL_FILE_OFFLOADED_OR_UNSAFE')
    return metadata


def read_bytes(path):
    metadata = resident_file(path)
    require(metadata.st_size <= MAX_ARCHIVE, 'LOCAL_FILE_TOO_LARGE')
    return path.read_bytes()


def file_hash(path):
    resident_file(path)
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def project(value):
    require(value in (SOURCE, TARGET), 'PROJECT_REFUSED')
    return value


def volume(kind, which):
    require(kind in ('db', 'storage'), 'VOLUME_KIND_REFUSED')
    return 'supabase_' + kind + '_' + project(which)


def private_path(path):
    path = Path(path)
    require(path.is_absolute() and not path.exists() and not path.is_symlink(), 'PRIVATE_DESTINATION_EXISTS')
    require(path.parent.resolve() == WORK.resolve()
            and re.fullmatch(r'office-restore-private-[A-Za-z0-9-]{4,80}', path.name),
            'PRIVATE_DESTINATION_REFUSED')
    return path


def verify_environment():
    require(os.environ.get('DOCKER_HOST') == HOST and not os.environ.get('DOCKER_CONTEXT'), 'DOCKER_ENDPOINT_REFUSED')
    require(not any(os.environ.get(k) for k in ('PYTHONINSPECT', 'PYTHONSTARTUP', 'PYTHONPATH',
                'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
                'http_proxy', 'https_proxy', 'all_proxy')), 'DEBUG_OR_PROXY_ENV_REFUSED')
    s = SOCKET.lstat()
    require(stat.S_ISSOCK(s.st_mode) and s.st_uid == os.getuid()
            and SOCKET.resolve() == (WORK / 'office-runtime/colima/office/docker.sock').resolve(),
            'DOCKER_SOCKET_REFUSED')
    require(CLI.is_file() and file_hash(CLI) == CLI_SHA, 'CLI_BINARY_REFUSED')


def command(args, *, data=None, output=None, timeout=45):
    """No shell, inherited credentials, raw diagnostics or unbounded shared output."""
    env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', 'DOCKER_HOST': HOST,
           'DOCKER_CONFIG': str(WORK / 'office-runtime/docker'),
           'SUPABASE_HOME': str(WORK / 'tools/supabase/2.117.0/state')}
    if 'HOME' in os.environ:
        env['HOME'] = os.environ['HOME']  # Preserve the real home; never repurpose it.
    try:
        result = subprocess.run(args, input=data, stdout=output or subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise Refused('SUBPROCESS_UNCONFIRMED') from None
    require(result.returncode == 0, 'SUBPROCESS_FAILED')
    require(len(result.stderr) < 8 * 1024 ** 2, 'SUBPROCESS_DIAGNOSTICS_TOO_LARGE')
    if output is None:
        require(len(result.stdout) < 8 * 1024 ** 2, 'SUBPROCESS_OUTPUT_TOO_LARGE')
    return result.stdout


def docker(*args, **kwargs):
    verify_environment()
    return command([DOCKER, '--host', HOST, *args], **kwargs)


def safe_member(member):
    name = member.name
    require(not name.startswith('/') and '\\' not in name and '\x00' not in name, 'ARCHIVE_PATH_REFUSED')
    parts = PurePosixPath(name).parts
    require('..' not in parts and all(len(p) <= 255 for p in parts), 'ARCHIVE_PATH_REFUSED')
    normalized = str(PurePosixPath(name))
    require(member.isdir() or member.isreg(), 'ARCHIVE_TYPE_REFUSED')
    require(0 <= member.size <= MAX_ARCHIVE and 0 <= member.uid < 65536
            and 0 <= member.gid < 65536 and not member.mode & 0o7000, 'ARCHIVE_METADATA_REFUSED')
    return normalized


def archive_manifest(path, *, require_root=True):
    require(0 < resident_file(path).st_size <= MAX_ARCHIVE, 'ARCHIVE_SIZE_REFUSED')
    rows = {}
    total = 0
    try:
        with tarfile.open(path, 'r:') as archive:
            for member in archive:
                name = safe_member(member)
                require(name not in rows and len(rows) < 30000, 'ARCHIVE_DUPLICATE_OR_LIMIT')
                row = {'kind': 'dir' if member.isdir() else 'file', 'size': member.size,
                       'uid': member.uid, 'gid': member.gid, 'mode': member.mode}
                if member.isreg():
                    h = hashlib.sha256()
                    stream = archive.extractfile(member)
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        h.update(block)
                    row['sha256'] = h.hexdigest()
                    total += member.size
                rows[name] = row
    except (tarfile.TarError, OSError):
        raise Refused('ARCHIVE_UNREADABLE') from None
    require((not require_root or ('.' in rows and rows['.']['kind'] == 'dir'))
            and rows and total <= MAX_ARCHIVE, 'ARCHIVE_ROOT_OR_LIMIT')
    return rows


def filtered_archive(source, destination, *, omit=None, only=None):
    require((omit is None) != (only is None), 'FILTER_MODE_REFUSED')
    inventory = archive_manifest(source)
    chosen = omit if omit is not None else only
    require(chosen in inventory and inventory[chosen]['kind'] == 'file', 'FILTER_PAYLOAD_REFUSED')
    require(not destination.exists(), 'ARCHIVE_OVERWRITE_REFUSED')
    with tarfile.open(source, 'r:') as old, tarfile.open(destination, 'w') as new:
        os.chmod(destination, 0o600)
        for member in old:
            name = safe_member(member)
            if (omit is not None and name == omit) or (only is not None and name != only):
                continue
            new.addfile(member, old.extractfile(member) if member.isreg() else None)


def helper_args(kind, which, *, write=False, program='tar'):
    project(which)
    require(not write or which == TARGET, 'SOURCE_WRITABLE_MOUNT_REFUSED')
    require(program == 'tar' or (program == 'pg_controldata' and kind == 'db' and not write),
            'HELPER_PROGRAM_REFUSED')
    mount = 'type=volume,src=' + volume(kind, which) + ',dst=/volume,volume-nocopy'
    if not write:
        mount += ',readonly'
    return ['run'] + (['--interactive'] if write else []) + ['--rm', '--pull=never', '--network', 'none', '--read-only', '--user', '0:0',
            '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER',
            '--security-opt=no-new-privileges', '--label', 'bcbc.restore.helper=' + which,
            '--env', 'LC_ALL=C', '--mount', mount,
            '--entrypoint', program, 'sha256:' + IMAGES['db'][1]]


def local_http(port, path, key=None):
    require(port in (55321, 55421), 'HTTP_PORT_REFUSED')
    require(path.startswith('/storage/v1/object/') and '?' not in path and '#' not in path
            and not any(c in path for c in '\r\n'), 'HTTP_PATH_REFUSED')
    headers = {'Connection': 'close'}
    if key:
        headers.update({'apikey': key, 'Authorization': 'Bearer ' + key})
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=15)
    try:
        connection.request('GET', path, headers=headers)
        result = connection.getresponse()
        body = result.read(MAX_HTTP + 1)
        require(len(body) <= MAX_HTTP, 'HTTP_SIZE_REFUSED')
        require(not 300 <= result.status < 400, 'HTTP_REDIRECT_REFUSED')
        return result.status, body
    except (OSError, http.client.HTTPException):
        raise Refused('HTTP_UNCONFIRMED') from None
    finally:
        connection.close()


def target_config(source):
    cfg = tomllib.loads(source.decode())
    require(cfg['project_id'] == SOURCE and cfg['db']['major_version'] == 17,
            'SOURCE_CONFIG_REFUSED')
    require(cfg['api']['port'] == 55321 and cfg['db']['port'] == 55322
            and cfg['local_smtp']['port'] == 55324, 'SOURCE_PORTS_REFUSED')
    require(cfg['api']['auto_expose_new_tables'] is False and not cfg['db']['seed']['enabled'],
            'SOURCE_EXPOSURE_OR_SEED_REFUSED')
    require(not cfg['auth'].get('smtp') and not cfg['auth']['email'].get('smtp')
            and not cfg['auth']['sms']['enable_signup']
            and not cfg['auth']['sms']['twilio']['enabled'], 'OUTBOUND_CONFIG_REFUSED')
    text = source.decode().replace('project_id = "' + SOURCE + '"', 'project_id = "' + TARGET + '"')
    text = re.sub(r'\b553(\d{2})\b', r'554\1', text)
    text = text.replace(':8810', ':8820')
    result = tomllib.loads(text)
    def normalize(value):
        if isinstance(value, dict):
            return {k: normalize(v) for k, v in value.items()}
        if isinstance(value, list):
            return [normalize(v) for v in value]
        if isinstance(value, int) and 55400 <= value <= 55499:
            return value - 100
        if isinstance(value, str):
            return value.replace(TARGET, SOURCE).replace(':8820', ':8810')
        return value
    require(normalize(result) == cfg, 'UNINTENDED_TARGET_CONFIG_CHANGE')
    return text.encode()


def snapshot_fingerprints(rows):
    require(set(rows) == set(TABLES), 'TABLE_INVENTORY_REFUSED')
    result = {}
    for table, records in rows.items():
        require(isinstance(records, list), 'TABLE_ROWS_REFUSED')
        stable = [{k: v for k, v in row.items()
                   if not (table == 'storage.objects' and k == 'last_accessed_at')}
                  for row in records]
        result[table] = {'count': len(stable), 'sha256': digest(canonical(sorted(stable, key=canonical)))}
    return result


def verify_source_rows(rows):
    require(len(rows['auth.users']) == 9 and all(
        re.fullmatch(r'[^\s@]+@[^\s@]+\.invalid', u.get('email') or '')
        and u.get('banned_until') for u in rows['auth.users']), 'NONFICTIONAL_OR_UNEXPECTED_AUTH')
    try:
        require(all(datetime.fromisoformat(u['banned_until'].replace('Z', '+00:00')) > datetime.now(timezone.utc)
                    for u in rows['auth.users']), 'AUTH_BAN_EXPIRED')
    except (ValueError, TypeError):
        raise Refused('AUTH_BAN_REFUSED') from None
    require(not rows['public.staff_roles'], 'SOURCE_STAFF_ACCESS_PRESENT')
    require(sorted(r['version'] for r in rows['supabase_migrations.schema_migrations']) == MIGRATIONS,
            'MIGRATION_HISTORY_REFUSED')
    docs, objects = rows['public.documents'], rows['storage.objects']
    require(len(docs) == len(objects) == 1, 'SOURCE_OBJECT_INVENTORY_REFUSED')
    require(len(rows['storage.buckets']) == 1 and rows['storage.buckets'][0]['id'] == 'church-documents'
            and rows['storage.buckets'][0]['public'] is False, 'PRIVATE_BUCKET_REFUSED')
    doc, obj = docs[0], objects[0]
    require(obj['bucket_id'] == 'church-documents' and doc['storage_path'] == obj['name']
            and obj['name'].startswith(doc['uploaded_by'] + '/'), 'DOCUMENT_OBJECT_LINK_REFUSED')
    require(any(h.get('source_document_id') == doc['id'] for h in rows['public.membership_history']),
            'HISTORY_PHOTO_LINK_MISSING')
    return obj


CATALOG_SQL = """
select json_build_object(
 'schemas',(select coalesce(json_agg(t),'[]') from (select nspname,nspacl::text from pg_namespace where nspname in ('public','private','storage','auth') order by 1)t),
 'defaults',(select coalesce(json_agg(t),'[]') from (select defaclrole::regrole::text as owner,n.nspname,defaclobjtype,defaclacl::text from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace order by 1,2,3)t),
 'policies',(select coalesce(json_agg(t),'[]') from (select * from pg_policies where schemaname in ('public','storage') order by schemaname,tablename,policyname)t),
 'relations',(select coalesce(json_agg(t),'[]') from (select n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','storage') and c.relkind in ('r','S') order by 1,2)t),
 'functions',(select coalesce(json_agg(t),'[]') from (select n.nspname,p.proname,p.oid::regprocedure::text as signature,p.prosecdef,p.proconfig,p.proacl::text,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f' order by 1,3)t),
 'foreign_keys',(select coalesce(json_agg(t),'[]') from (select c.conname,c.convalidated,c.confmatchtype as conmatchtype,n.nspname as child_schema,r.relname as child_table,pn.nspname as parent_schema,pr.relname as parent_table,pg_get_constraintdef(c.oid) as definition,array(select a.attname from unnest(c.conkey) with ordinality k(num,ord) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num order by k.ord) as child_columns,array(select a.attname from unnest(c.confkey) with ordinality k(num,ord) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.num order by k.ord) as parent_columns from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace join pg_class pr on pr.oid=c.confrelid join pg_namespace pn on pn.oid=pr.relnamespace where c.contype='f' and n.nspname='public' order by n.nspname,r.relname,c.conname)t));
"""


def foreign_key_query(constraints):
    checks = []
    for c in constraints:
        child = c['child_schema'] + '.' + c['child_table']
        parent = c['parent_schema'] + '.' + c['parent_table']
        require(child in TABLES and parent in TABLES and c['convalidated']
                and c['conmatchtype'] == 's', 'FOREIGN_KEY_DEFINITION_REFUSED')
        left, right = c['child_columns'], c['parent_columns']
        require(left and len(left) == len(right) and all(re.fullmatch(r'[a-z_][a-z0-9_]*', col)
                for col in left + right), 'FOREIGN_KEY_COLUMNS_REFUSED')
        checks.append('(select count(*) from ' + child + ' c where '
                      + ' and '.join('c."' + col + '" is not null' for col in left)
                      + ' and not exists (select 1 from ' + parent + ' p where '
                      + ' and '.join('c."' + a + '"=p."' + b + '"' for a, b in zip(left, right)) + '))')
    require(checks, 'FOREIGN_KEY_INVENTORY_EMPTY')
    return 'select ' + '+'.join(checks) + ';'


class Rehearsal:
    def __init__(self, destination):
        self.directory = private_path(destination)
        self.directory.mkdir(mode=0o700)
        self.run_id = uuid.uuid4().hex
        self.target_dir = self.directory / 'target'
        self.network = TARGET + '-loopback-' + self.run_id[:8]
        self.state = {'status': 'running', 'stage': 'created', 'run_id': self.run_id,
                      'source': SOURCE, 'target': TARGET, 'target_network': self.network, 'checks': [], 'created_volumes': [],
                      'source_stopped': False, 'target_started': False, 'cleanup_unconfirmed': False}
        self.started = time.monotonic()
        self.archives = {}
        self.save()

    def save(self):
        path = self.directory / 'state.json'
        temporary = self.directory / '.state.tmp'
        with temporary.open('w') as out:
            os.chmod(temporary, 0o600)
            json.dump(self.state, out, indent=2)
            out.flush()
            os.fsync(out.fileno())
        temporary.replace(path)

    def stage(self, name):
        self.state['stage'] = name
        self.save()
        print(json.dumps({'stage': name, 'status': 'running'}), flush=True)

    def passed(self, name):
        self.state['checks'].append({'check': name, 'status': 'passed'})
        self.save()

    def private_json(self, name, value):
        path = self.directory / name
        require(not path.exists(), 'PRIVATE_FILE_OVERWRITE_REFUSED')
        with path.open('x') as out:
            os.chmod(path, 0o600)
            json.dump(value, out, indent=2)

    def cli(self, which, *args):
        folder = SOURCE_DIR if project(which) == SOURCE else self.target_dir
        require(not (folder / 'supabase/.temp/project-ref').exists(), 'LINKED_PROJECT_REFUSED')
        require(tomllib.loads(read_bytes(folder / 'supabase/config.toml').decode())['project_id'] == which,
                'CLI_DIRECTORY_ID_REFUSED')
        return command([str(CLI), *args, '--workdir', str(folder)], timeout=240)

    def inspections(self, which):
        names = ['supabase_' + service + '_' + project(which) for service in IMAGES]
        data = json.loads(docker('inspect', *names))
        require(len(data) == len(IMAGES), 'SERVICE_COUNT_REFUSED')
        registered = docker('ps', '-aq', '--filter', 'label=com.supabase.cli.project=' + which).decode().split()
        require(len(registered) == len(IMAGES) and all(any(item['Id'].startswith(identifier)
                for item in data) for identifier in registered), 'UNEXPECTED_PROJECT_CONTAINERS')
        for item in data:
            service = next((k for k in IMAGES if item['Name'] == '/supabase_' + k + '_' + which), None)
            require(service is not None and item['Image'] == 'sha256:' + IMAGES[service][1], 'SERVICE_IMAGE_REFUSED')
            require(item['Config']['Labels'].get('com.supabase.cli.project') == which,
                    'SERVICE_PROJECT_LABEL_REFUSED')
            require(item['State']['Running'] and item['State'].get('Health', {}).get('Status', 'healthy') == 'healthy',
                    'SERVICE_UNHEALTHY')
            base = 55300 if which == SOURCE else 55400
            allowed_port = {'db': str(base + 22), 'kong': str(base + 21), 'inbucket': str(base + 24)}.get(service)
            published = [b for bindings in item['NetworkSettings']['Ports'].values() if bindings for b in bindings]
            require(len(published) == (1 if allowed_port else 0) and all(
                b['HostIp'] == '127.0.0.1' and b['HostPort'] == allowed_port for b in published), 'SERVICE_BINDING_REFUSED')
            if service in ('db', 'storage'):
                mounts = item['Mounts']
                expected = '/var/lib/postgresql/data' if service == 'db' else '/mnt'
                require(len(mounts) == 1 and mounts[0]['Type'] == 'volume'
                        and mounts[0]['Name'] == volume(service, which)
                        and mounts[0]['Destination'] == expected, 'SERVICE_MOUNT_REFUSED')
                env = dict(pair.split('=', 1) for pair in item['Config']['Env'] if '=' in pair)
                if service == 'db':
                    require(env.get('PGDATA') == expected, 'PGDATA_REFUSED')
                else:
                    require(env.get('STORAGE_BACKEND') == 'file' and env.get('FILE_STORAGE_BACKEND_PATH') == '/mnt'
                            and env.get('TENANT_ID') == env.get('GLOBAL_S3_BUCKET') == 'stub', 'STORAGE_BACKEND_REFUSED')
        return data

    def no_running_mounts(self, which):
        ids = docker('ps', '-q').decode().split()
        if ids:
            running = json.loads(docker('inspect', *ids))
            require(not any(m.get('Name') in {volume('db', which), volume('storage', which)}
                            for item in running for m in item.get('Mounts', [])), 'VOLUME_STILL_RUNNING')

    def stop(self, which):
        if which == SOURCE:
            self.state['source_stop_attempted'] = True
            self.save()
        self.cli(which, 'stop')  # Deliberately no --all or --no-backup.
        self.no_running_mounts(which)
        if which == SOURCE:
            self.state['source_stopped'] = True
        else:
            self.state['target_started'] = False
        self.save()

    def sql(self, which, query):
        self.inspections(which)
        return docker('exec', '-i', 'supabase_db_' + project(which), 'psql', '-X', '--no-password',
                      '--username=postgres', '--dbname=postgres', '--set=ON_ERROR_STOP=1',
                      '--set=VERBOSITY=sqlstate', '--tuples-only', '--no-align', '--quiet',
                      data=('begin read only;\n' + query + '\ncommit;\n').encode()).decode().strip()

    def snapshot(self, which):
        inventory = json.loads(self.sql(which, "select coalesce(json_agg(tablename order by tablename),'[]') from pg_tables where schemaname='public';"))
        require(inventory == sorted(APP_TABLES), 'PUBLIC_TABLE_INVENTORY_REFUSED')
        pairs = ["'" + table + "',(select coalesce(json_agg(t),'[]') from " + table + ' t)' for table in TABLES]
        rows = json.loads(self.sql(which, 'select json_build_object(' + ','.join(pairs) + ');'))
        obj = verify_source_rows(rows)
        catalog = json.loads(self.sql(which, CATALOG_SQL))
        require(self.sql(which, foreign_key_query(catalog['foreign_keys'])) == '0', 'FOREIGN_KEY_ORPHANS')
        require(self.sql(which, "select count(*) from pg_tablespace where spcname not in ('pg_default','pg_global');") == '0',
                'EXTERNAL_TABLESPACE_REFUSED')
        return {'tables': snapshot_fingerprints(rows), 'catalog_sha256': digest(canonical(catalog)),
                'foreign_key_count': len(catalog['foreign_keys'])}, obj

    def service_key(self, which):
        values = {k.lower(): v for k, v in json.loads(self.cli(which, 'status', '--output', 'json')).items()}
        expected = 'http://127.0.0.1:' + ('55321' if which == SOURCE else '55421')
        require(values.get('api_url', '').rstrip('/') == expected, 'STATUS_API_REFUSED')
        key = values.get('service_role_key') or values.get('secret_key')
        require(isinstance(key, str), 'LOCAL_SERVICE_KEY_MISSING')
        if not re.fullmatch(r'sb_secret_[A-Za-z0-9_-]+', key):
            try:
                parts = key.split('.')
                claims = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
                require(len(parts) == 3 and claims.get('role') == 'service_role', 'LOCAL_SERVICE_KEY_REFUSED')
            except (ValueError, IndexError):
                raise Refused('LOCAL_SERVICE_KEY_REFUSED') from None
        return key

    def object_bytes(self, which, obj, *, missing=False):
        path = quote(obj['name'], safe='/')
        port = 55321 if which == SOURCE else 55421
        status, body = local_http(port, '/storage/v1/object/authenticated/church-documents/' + path,
                                  self.service_key(which))
        if missing:
            try:
                error = json.loads(body)
            except (ValueError, TypeError):
                error = {}
            code = error.get('code') if isinstance(error, dict) else None
            safe_code = code if code in ('NoSuchKey', 'NotFound', 'InternalError') else 'other'
            evidence = {'http_status': status, 'storage_error_code': safe_code}
            self.private_json('missing-object-response-' + uuid.uuid4().hex[:8] + '.json', error)
            if status == 500 and safe_code == 'InternalError':
                # The file backend can report a missing on-disk payload as HTTP500.
                # Accept only with this exact absent payload's ENOENT in its local service log.
                logs = docker('logs', '--tail', '300', 'supabase_storage_' + project(which))
                self.private_json('missing-object-private-log-' + uuid.uuid4().hex[:8] + '.json',
                                  {'service_log': logs.decode(errors='replace')})
                path = '/mnt/' + self.missing_payload
                evidence['exact_missing_payload_enoent'] = any(
                    b'ENOENT' in line and re.search(re.escape(path.encode()) + rb"(?=['\"\s,}\]]|$)", line) is not None
                    for line in logs.splitlines())
            self.state['missing_file_response'] = evidence
            self.save()
            require(status in (400, 404) or (status == 500 and safe_code == 'InternalError'
                    and evidence.get('exact_missing_payload_enoent') is True), 'MISSING_OBJECT_FAILURE_NOT_PROVEN')
            return None
        require(status == 200 and body, 'PRIVATE_OBJECT_DOWNLOAD_FAILED')
        denied, _ = local_http(port, '/storage/v1/object/public/church-documents/' + path)
        require(denied in (400, 401, 403, 404), 'ANONYMOUS_PRIVATE_OBJECT_EXPOSED')
        return {'bytes': len(body), 'sha256': digest(body)}

    def capture(self, kind, which, filename):
        self.no_running_mounts(which)
        destination = self.directory / filename
        require(not destination.exists(), 'ARCHIVE_OVERWRITE_REFUSED')
        with destination.open('xb') as out:
            os.chmod(destination, 0o600)
            docker(*helper_args(kind, which), '-C', '/volume', '-cf', '-', '.', output=out, timeout=180)
            out.flush()
            os.fsync(out.fileno())
        manifest = archive_manifest(destination)
        self.archives[str(destination)] = (file_hash(destination), manifest, True)
        return destination, manifest

    def volume_details(self, kind, which):
        name = volume(kind, which)
        details = json.loads(docker('volume', 'inspect', name))[0]
        require(details['Name'] == name and details['Driver'] == 'local' and not details.get('Options')
                and details.get('Labels', {}).get('com.supabase.cli.project') == which
                and details.get('Mountpoint', '').endswith('/' + name + '/_data'), 'VOLUME_DRIVER_OR_LABEL_REFUSED')
        return details

    def own_target_volume(self, kind):
        name = volume(kind, TARGET)
        require(name in self.state['created_volumes'], 'TARGET_VOLUME_NOT_REGISTERED')
        details = self.volume_details(kind, TARGET)
        require(details['Name'] == name and details.get('Labels', {}).get('bcbc.restore.run') == self.run_id,
                'TARGET_VOLUME_OWNERSHIP_REFUSED')

    def extract(self, kind, archive):
        self.own_target_volume(kind)
        self.no_running_mounts(TARGET)
        require(str(archive) in self.archives, 'UNREGISTERED_ARCHIVE_REFUSED')
        expected_hash, expected_manifest, root_required = self.archives[str(archive)]
        require(file_hash(archive) == expected_hash and archive_manifest(archive, require_root=root_required) == expected_manifest,
                'ARCHIVE_CHANGED_BEFORE_RESTORE')
        payload = read_bytes(archive)
        require(len(payload) <= MAX_ARCHIVE and digest(payload) == expected_hash, 'ARCHIVE_CHANGED_DURING_READ')
        docker(*helper_args(kind, TARGET, write=True), '-C', '/volume', '-xf', '-', '--numeric-owner', '-k',
               data=payload, timeout=180)

    def start_target(self):
        for service, (tag, expected) in IMAGES.items():
            actual = json.loads(docker('image', 'inspect', 'public.ecr.aws/supabase/' + tag))[0]['Id']
            require(actual == 'sha256:' + expected, 'CACHED_IMAGE_CHANGED')
        self.state['target_start_attempted'] = True
        self.save()
        self.cli(TARGET, 'start', '--network-id', self.network, '--exclude', EXCLUDED)
        self.state['target_started'] = True
        self.save()
        self.inspections(TARGET)

    def prepare_target(self):
        require(not self.target_dir.exists(), 'TARGET_DIRECTORY_EXISTS')
        require(not docker('ps', '-aq', '--filter', 'label=com.supabase.cli.project=' + TARGET).strip(),
                'TARGET_CONTAINERS_EXIST')
        existing_volumes = docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
        require(not any(volume(k, TARGET) in existing_volumes for k in ('db', 'storage')), 'TARGET_VOLUMES_EXIST')
        require(self.network not in docker('network', 'ls', '--format', '{{.Name}}').decode().splitlines(),
                'TARGET_NETWORK_EXISTS')
        for port in (55421, 55422, 55424):
            try:
                with socket.socket() as probe:
                    probe.bind(('127.0.0.1', port))
            except OSError:
                raise Refused('TARGET_PORT_IN_USE') from None
        config = SOURCE_DIR / 'supabase/config.toml'
        require(not (SOURCE_DIR / 'supabase/.temp/project-ref').exists(), 'SOURCE_LINKED_PROJECT_REFUSED')
        new_config = target_config(read_bytes(config))
        manifest = json.loads(read_bytes(REPO / 'tools/office-preflight/manifest.json'))
        files = []
        expected = []
        for entry in manifest['sql_files']:
            rel = entry['path']
            require(re.fullmatch(r'supabase/migrations/\d{14}_[a-z_]+\.sql', rel), 'MIGRATION_PATH_REFUSED')
            expected.append(Path(rel).name)
            payload = read_bytes(REPO / rel)
            require(digest(payload) == entry['sha256'] and read_bytes(SOURCE_DIR / rel) == payload,
                    'MIGRATION_BYTES_REFUSED')
            files.append((rel, payload))
        require(sorted(name[:14] for name in expected) == MIGRATIONS and sorted(expected) == sorted(
            p.name for p in (SOURCE_DIR / 'supabase/migrations').glob('*.sql')), 'MIGRATION_INVENTORY_REFUSED')
        (self.target_dir / 'supabase/migrations').mkdir(parents=True, mode=0o700)
        (self.target_dir / 'supabase/config.toml').write_bytes(new_config)
        for rel, payload in files:
            (self.target_dir / rel).write_bytes(payload)
        self.state['target_config_sha256'] = digest(new_config)
        self.state['source_config_sha256'] = file_hash(config)
        self.save()

    def create_target_volumes(self):
        # Match the proven local stack: an internal bridge prevented CLI access to its published DB port.
        docker('network', 'create', '--driver', 'bridge', '--label', 'bcbc.restore.run=' + self.run_id,
               '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', self.network)
        for kind in ('db', 'storage'):
            name = volume(kind, TARGET)
            # Recheck absence immediately before a creation API that can reuse names.
            require(name not in docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines(),
                    'TARGET_VOLUME_APPEARED')
            created = docker('volume', 'create', '--label', 'com.supabase.cli.project=' + TARGET,
                             '--label', 'bcbc.restore.run=' + self.run_id, name).decode().strip()
            require(created == name, 'TARGET_VOLUME_CREATION_UNCONFIRMED')
            self.state['created_volumes'].append(name)
            self.save()
            self.own_target_volume(kind)
            _, empty = self.capture(kind, TARGET, 'empty-' + kind + '.tar')
            require(set(empty) == {'.'}, 'TARGET_VOLUME_NOT_EMPTY')

    def run(self):
        self.stage('source-preflight')
        verify_environment()
        require(command([str(CLI), '--version']).decode().strip() == '2.117.0', 'CLI_VERSION_REFUSED')
        self.inspections(SOURCE)
        source_volumes = [self.volume_details(kind, SOURCE) for kind in ('db', 'storage')]
        volume_identity = digest(canonical(source_volumes))
        self.prepare_target()
        baseline, obj = self.snapshot(SOURCE)
        require(self.sql(SOURCE, "select current_setting('server_version');").startswith('17.6'),
                'POSTGRES_VERSION_REFUSED')
        expected_object = self.object_bytes(SOURCE, obj)
        require(self.snapshot(SOURCE)[0] == baseline, 'SOURCE_CHANGED_DURING_BASELINE')
        self.private_json('baseline.json', {'fingerprints': baseline, 'object': obj, 'bytes': expected_object})
        self.state['source_inventory'] = {table: record['count'] for table, record in baseline['tables'].items()}
        self.passed('source_synthetic_inventory_links_and_private_bytes')

        self.stage('source-quiesce-and-cold-capture')
        self.stop(SOURCE)
        control = docker(*helper_args('db', SOURCE, program='pg_controldata'), '/volume').decode()
        require(re.search(r'^Database cluster state:\s+shut down\s*$', control, re.M), 'POSTGRES_CLEAN_SHUTDOWN_UNCONFIRMED')
        self.passed('postgres_control_file_confirms_clean_shutdown')
        originals = {}
        inventories = {}
        hashes = {}
        for kind in ('db', 'storage'):
            archive, inventory = self.capture(kind, SOURCE, kind + '-pristine.tar')
            originals[kind], inventories[kind], hashes[kind] = archive, inventory, file_hash(archive)
        require(inventories['db']['.']['uid'] == 100 and inventories['db']['.']['gid'] == 101
                and inventories['db']['.']['mode'] == 0o700, 'PGDATA_ROOT_OWNERSHIP_REFUSED')
        require('postmaster.pid' not in inventories['db'], 'POSTGRES_SHUTDOWN_UNCONFIRMED')
        self.private_json('volume-manifests.json', inventories)
        self.state['archive_sha256'] = hashes
        self.passed('complete_cold_volume_archives_validated')

        candidates = [name for name, row in inventories['storage'].items()
                      if row['kind'] == 'file' and row.get('sha256') == expected_object['sha256']
                      and row['size'] == expected_object['bytes'] and not name.endswith(('.json', '.info'))]
        require(len(candidates) == 1, 'EXACT_STORAGE_PAYLOAD_NOT_UNIQUE')
        missing_path = candidates[0]
        missing_archive = self.directory / 'storage-intentionally-incomplete.tar'
        filtered_archive(originals['storage'], missing_archive, omit=missing_path)
        incomplete = {name: row for name, row in inventories['storage'].items() if name != missing_path}
        require(archive_manifest(missing_archive) == incomplete, 'INCOMPLETE_FIXTURE_MISMATCH')
        self.archives[str(missing_archive)] = (file_hash(missing_archive), incomplete, True)

        self.stage('restore-into-empty-target-volumes')
        self.create_target_volumes()
        return self.finish_restore(baseline, expected_object, originals, inventories, hashes,
                                   missing_path, missing_archive, incomplete, volume_identity)

    def finish_restore(self, baseline, expected_object, originals, inventories, hashes,
                       missing_path, missing_archive, incomplete, volume_identity):
        """Extraction onward; caller must have independently proved exact empty target volumes."""
        self.restore_started = time.monotonic()
        self.state['extraction_started_at_utc'] = datetime.now(timezone.utc).isoformat()
        self.save()
        self.extract('db', originals['db'])
        self.extract('storage', missing_archive)
        _, database_copy = self.capture('db', TARGET, 'target-db-before-start.tar')
        _, storage_copy = self.capture('storage', TARGET, 'target-storage-incomplete-before-start.tar')
        require(database_copy == inventories['db'] and storage_copy == incomplete, 'PRESTART_VOLUME_HASH_MISMATCH')
        self.passed('target_prestart_database_bytes_and_incomplete_storage_match')

        return self.complete_restored_target(baseline, expected_object, originals, inventories, hashes,
                                             missing_path, incomplete, volume_identity)

    def complete_restored_target(self, baseline, expected_object, originals, inventories, hashes,
                                 missing_path, incomplete, volume_identity):
        """Resume only after a reviewed intact DB and deliberately incomplete Storage are proven."""
        self.missing_payload = missing_path
        self.stage('prove-missing-file-failure')
        self.start_target()
        restored, restored_obj = self.snapshot(TARGET)
        require(restored == baseline, 'INCOMPLETE_TARGET_DATABASE_MISMATCH')
        self.object_bytes(TARGET, restored_obj, missing=True)
        self.state['missing_file_phase'] = {'database_matched': True, 'byte_verifier_rejected': True,
                                           'status': 'expected_failure_proven'}
        self.passed('running_target_detected_missing_private_object')

        self.stage('correct-only-the-absent-target-payload')
        self.stop(TARGET)
        require(all(file_hash(originals[k]) == hashes[k] for k in originals), 'PRISTINE_BACKUP_CHANGED')
        _, before_correction = self.capture('storage', TARGET, 'target-storage-before-correction.tar')
        require(before_correction == incomplete and missing_path not in before_correction,
                'TARGET_CHANGED_BEFORE_CORRECTION')
        correction = self.directory / 'exact-missing-payload.tar'
        filtered_archive(originals['storage'], correction, only=missing_path)
        correction_manifest = archive_manifest(correction, require_root=False)
        require(correction_manifest == {missing_path: inventories['storage'][missing_path]}, 'CORRECTION_PAYLOAD_MISMATCH')
        self.archives[str(correction)] = (file_hash(correction), correction_manifest, False)
        self.extract('storage', correction)
        _, after_correction = self.capture('storage', TARGET, 'target-storage-after-correction.tar')
        require(after_correction == inventories['storage'], 'CORRECTED_STORAGE_HASH_MISMATCH')
        self.start_target()
        final, final_obj = self.snapshot(TARGET)
        require(final == baseline, 'RESTORED_DATABASE_FINGERPRINT_MISMATCH')
        require(self.object_bytes(TARGET, final_obj) == expected_object, 'RESTORED_PRIVATE_BYTES_MISMATCH')
        self.state['restored_object_count'] = 1
        self.state['restored_object_bytes'] = expected_object['bytes']
        self.state['restore_elapsed_seconds'] = round(time.monotonic() - self.restore_started, 3)
        self.passed('corrected_target_logical_data_policy_links_and_private_bytes')

        self.stage('verify-source-preservation-and-stop')
        self.stop(TARGET)
        self.no_running_mounts(SOURCE)
        require(digest(canonical([self.volume_details(kind, SOURCE) for kind in ('db', 'storage')])) == volume_identity,
                'SOURCE_VOLUME_IDENTITY_CHANGED')
        for kind in ('db', 'storage'):
            _, preserved = self.capture(kind, SOURCE, 'source-' + kind + '-preservation-check.tar')
            require(preserved == inventories[kind], 'SOURCE_VOLUME_BYTES_CHANGED')
        require(file_hash(SOURCE_DIR / 'supabase/config.toml') == self.state['source_config_sha256'],
                'SOURCE_CONFIG_CHANGED')
        self.passed('source_volume_bytes_unchanged_and_both_stacks_stopped')
        self.state.update(status='passed_local_restore_only', stage='complete',
                          total_elapsed_seconds=round(time.monotonic() - self.started, 3),
                          next_action='Keep private archives and both preserved volume pairs; parent chooses any later cleanup.')
        self.save()
        return self.state

    def failed(self, code):
        failed_stage = self.state['stage']
        self.state.update(status='failed', error=code, failed_stage=failed_stage,
                          next_action='Do not rerun into these volumes. Review this stage and private manifests; preserve source and target. No automatic reset/resume is supported.')
        # Stop only this run's target attempt and the exact source already touched by this run.
        if self.state.get('target_start_attempted'):
            try:
                self.stop(TARGET)
            except Exception:
                self.state['cleanup_unconfirmed'] = True
        if self.state.get('created_volumes'):
            try:
                self.no_running_mounts(TARGET)
            except Exception:
                self.state['cleanup_unconfirmed'] = True
        if self.state.get('source_stop_attempted'):
            try:
                self.no_running_mounts(SOURCE)
            except Exception:
                self.state['cleanup_unconfirmed'] = True
        self.save()
        return self.state


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--run', action='store_true', help='Explicitly perform this fixed local restore drill.')
    parser.add_argument('--private-dir', required=True, type=Path,
                        help='New work/office-restore-private-<suffix> directory outside the app repository.')
    args = parser.parse_args()
    runner = None
    try:
        require(args.run, 'EXPLICIT_RUN_REQUIRED')
        verify_environment()
        runner = Rehearsal(args.private_dir)
        report = runner.run()
    except BaseException as error:
        code = str(error) if isinstance(error, Refused) else 'RUN_INTERRUPTED' if isinstance(error, KeyboardInterrupt) else 'UNEXPECTED_FAILURE'
        report = runner.failed(code) if runner else {'status': 'refused', 'error': code}
    # State contains only sanitized outcome metadata; raw rows, paths and archives stay private.
    print(json.dumps(report, sort_keys=True), flush=True)
    return 0 if report.get('status') == 'passed_local_restore_only' else 1


if __name__ == '__main__':
    sys.exit(main())
