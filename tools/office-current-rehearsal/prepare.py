#!/usr/bin/env python3
"""Prepare one separate current-baseline local rehearsal; never start services."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tomllib

REPO = Path(__file__).resolve().parents[2]
PROJECT = 'bcbc-office-current-rehearsal-v2'
SOURCE_CONFIG_SHA256 = '88ce777af740bdc8dd9d0560a50a429ddedf91467e0b0841b57253f81ca6f580'
PORTS = {'api': 55521, 'db': 55522, 'shadow': 55520, 'smtp': 55524, 'browser': 8830}
MIGRATIONS = (
    ('20260908220558_office_base.sql', '8c8a971885d4d2ec60a3f57c4a416ecc2bb6282c4b9065bc67ed87280bc2a28b'),
    ('20260908220613_membership_care.sql', '3c2fa9df159b4b7d6c6c84a9d883cac6d4dde411aa01f26df802d9665cee5b53'),
    ('20260908220623_office_content.sql', 'e4d287bfcfc8f8c6f68b7a217fe2abe87e7f7c337a548bb991dc6bbe441783a7'),
    ('20260908220645_app_connections_care_roles.sql', '41fed80650afca46abb763569173e4a4656610634b60bbd6dd223c7ec103875d'),
    ('20260908220658_leader_followups.sql', '63c1d7400f99bdb1ffff9d616b93affc7321004bff6cac459ba31b4b59cbfc34'),
    ('20260908220707_office_record_recovery.sql', 'c8d53cb0b4025d4d36b03169a50ff30f7d1eb8956357e0b1130e2bfbbbeb8b7b'),
    ('20260908220718_pause_public_app_intake.sql', '8eba1837cffba0ca00934faccc4308239b4b49f534a4ba1a968a71bd7eeb00e3'),
)


class PrepareError(Exception):
    """Fixed diagnostic code; never a source value or private path."""


def require(condition, code):
    if not condition:
        raise PrepareError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def directory_fd(path):
    """Open an existing physical absolute directory without traversing links."""
    require(path.is_absolute() and '..' not in path.parts, 'PHYSICAL_PATH_REQUIRED')
    descriptor = None
    try:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        descriptor = os.open(path.parts[0], flags)
        for part in path.parts[1:]:
            next_descriptor = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except OSError:
        if descriptor is not None:
            os.close(descriptor)
        raise PrepareError('PHYSICAL_PATH_REQUIRED') from None


def read_source(path, limit=8 * 1024 * 1024):
    parent = directory_fd(path.parent)
    descriptor = None
    try:
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        metadata = os.fstat(descriptor)
        require(stat.S_ISREG(metadata.st_mode) and not getattr(metadata, 'st_flags', 0) & 0x40000000
                and metadata.st_size <= limit, 'SOURCE_FILE_UNSAFE')
        stream = os.fdopen(descriptor, 'rb')
        descriptor = None
        with stream:
            data = stream.read(limit + 1)
        require(len(data) <= limit, 'SOURCE_FILE_UNSAFE')
        return data
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def current_config(source):
    require(sha(source) == SOURCE_CONFIG_SHA256, 'SOURCE_CONFIG_CHANGED')
    original = tomllib.loads(source.decode('utf-8'))
    require(original['project_id'] == 'bcbc-office-rehearsal'
            and original['auth']['enable_signup'] is True
            and original['auth']['email']['enable_signup'] is True, 'SOURCE_CONFIG_CHANGED')
    text = source.decode('utf-8').replace(
        'project_id = "bcbc-office-rehearsal"', 'project_id = "' + PROJECT + '"', 1
    )
    text = re.sub(r'\b553(\d{2})\b', r'555\1', text).replace(':8810', ':8830')
    section, changed, lines = '', [], []
    for line in text.splitlines(keepends=True):
        header = re.fullmatch(r'\[([^\]]+)\]', line.strip())
        if header:
            section = header[1]
        if section == 'auth' and line.strip() == 'enable_signup = true':
            line = line.replace('enable_signup = true', 'enable_signup = false', 1)
            changed.append(section)
        lines.append(line)
    require(changed == ['auth'], 'CONFIG_TRANSFORM_REFUSED')
    result = ''.join(lines).encode('utf-8')
    expected = copy.deepcopy(original)

    def remap(value):
        if isinstance(value, dict):
            return {key: remap(item) for key, item in value.items()}
        if isinstance(value, list):
            return [remap(item) for item in value]
        if type(value) is int and 55300 <= value <= 55399:
            return value + 200
        if isinstance(value, str):
            return value.replace(':8810', ':8830')
        return value

    expected = remap(expected)
    expected['project_id'] = PROJECT
    expected['auth']['enable_signup'] = False
    # CLI 2.117 also uses auth.email.enable_signup to enable the email provider.
    # Preserve it for password sign-in; the global flag blocks public signup.
    require(tomllib.loads(result.decode('utf-8')) == expected, 'CONFIG_TRANSFORM_REFUSED')
    return result


def payloads():
    link = REPO / 'supabase/.temp/project-ref'
    require(not link.exists() and not link.is_symlink(), 'LINKED_SOURCE_REFUSED')
    manifest = json.loads(read_source(REPO / 'tools/office-preflight/manifest.json'))
    require(manifest['format_version'] == 2 and manifest['schema_revision'] == '20260907174301',
            'MANIFEST_REFUSED')
    expected = []
    for name, digest in MIGRATIONS:
        path = 'supabase/migrations/' + name
        expected.append({'path': path, 'sha256': digest,
                         'depends_on': [expected[-1]['path']] if expected else []})
    require(manifest['sql_files'] == expected, 'MIGRATION_MANIFEST_REFUSED')
    inventory = sorted(path.name for path in (REPO / 'supabase/migrations').glob('*.sql'))
    require(inventory == [name for name, _ in MIGRATIONS], 'MIGRATION_INVENTORY_REFUSED')
    files = {'supabase/config.toml': current_config(read_source(REPO / 'tools/office-local-stack/config.toml'))}
    for entry in expected:
        data = read_source(REPO / entry['path'])
        require(sha(data) == entry['sha256'], 'MIGRATION_HASH_REFUSED')
        files[entry['path']] = data
    return files


def git_ancestor(path):
    for parent in (path, *path.parents):
        marker = parent / '.git'
        if marker.exists() or marker.is_symlink():
            return True
        if (parent / 'HEAD').is_file() and (parent / 'objects').is_dir() and (parent / 'refs').is_dir():
            return True
    return False


def write_exclusive(directory, name, data):
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory)
    with os.fdopen(descriptor, 'wb') as target:
        os.fchmod(target.fileno(), 0o600)
        target.write(data)
        target.flush()
        os.fsync(target.fileno())


def prepare(destination: Path) -> dict:
    """Write only a new private local configuration and seven verified SQL copies."""
    opened = []
    try:
        destination = Path(destination)
        require(destination.is_absolute() and '..' not in destination.parts
                and not destination.is_relative_to(REPO) and not REPO.is_relative_to(destination),
                'DESTINATION_REFUSED')
        parent = directory_fd(destination.parent)
        opened.append(parent)
        require(not git_ancestor(destination.parent), 'REPOSITORY_DESTINATION_REFUSED')
        try:
            os.stat(destination.name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise PrepareError('DESTINATION_EXISTS')
        files = payloads()
        report = {
            'format_version': 1, 'status': 'prepared_not_started', 'project_id': PROJECT,
            'ports': dict(PORTS), 'source_config_sha256': SOURCE_CONFIG_SHA256,
            'config_sha256': sha(files['supabase/config.toml']),
            'migration_count': 7, 'payload_file_count': 8, 'output_file_count': 9,
            'migration_versions': [name[:14] for name, _ in MIGRATIONS],
            'files': [{'path': path, 'sha256': sha(data), 'bytes': len(data)} for path, data in files.items()],
            'started': False, 'hosted_calls': False,
        }
        os.mkdir(destination.name, mode=0o700, dir_fd=parent)
        root = os.open(destination.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        opened.append(root)
        os.fchmod(root, 0o700)
        directories = {'': root}
        for rel, container in (('supabase', ''), ('supabase/migrations', 'supabase')):
            name = Path(rel).name
            os.mkdir(name, mode=0o700, dir_fd=directories[container])
            descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directories[container])
            opened.append(descriptor)
            os.fchmod(descriptor, 0o700)
            directories[rel] = descriptor
        for path, data in files.items():
            write_exclusive(directories[str(Path(path).parent)], Path(path).name, data)
        write_exclusive(root, 'preparation.json', (json.dumps(report, indent=2) + '\n').encode('utf-8'))
        return report
    except PrepareError:
        raise
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        # A partially created destination remains preserved; never delete or reuse it.
        raise PrepareError('PREPARATION_FAILED') from None
    finally:
        for descriptor in reversed(opened):
            os.close(descriptor)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise PrepareError('INVALID_ARGUMENTS')


def main(argv=None):
    values = list(sys.argv[1:] if argv is None else argv)
    wants_json = any(value == '--json' or value.startswith('--json=') for value in values)
    parser = Parser(prog='prepare.py', description=__doc__, allow_abbrev=False)
    parser.add_argument('destination', type=Path, help='New physical private folder outside Git; its parent must exist.')
    parser.add_argument('--json', action='store_true', help='Print only a sanitized preparation manifest.')
    try:
        args = parser.parse_args(values)
        report = prepare(args.destination)
    except PrepareError as error:
        report = {'status': 'refused', 'error': str(error), 'started': False, 'hosted_calls': False}
        print(json.dumps(report) if wants_json else 'Preparation refused: ' + str(error) + '. No services started.',
              file=sys.stdout if wants_json else sys.stderr)
        return 2
    print(json.dumps(report, indent=2) if args.json else
          'Prepared a new private current-baseline rehearsal: seven verified migrations and local-only config. No services started.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
