#!/usr/bin/env python3
"""Prepare one fixed private account-guard rehearsal; never start services."""
from __future__ import annotations

import copy
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys
import tomllib

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
WORK = Path(pwd.getpwuid(os.getuid()).pw_dir) / 'Documents/Codex/2026-09-04/im-x20/work'
DESTINATION = WORK / 'office-account-guard-service-private-20260909/stack'
PROJECT = 'bcbc-office-account-guard-v1'
PORTS = {'api': 55821, 'db': 55822, 'shadow': 55820, 'smtp': 55824, 'browser': 8833}
ORIGIN = 'http://127.0.0.1:55821'
CONFIG_SHA256 = '1cd09cbbe5787004dca031329c71e8de5242b54c89c586cf904623b5b2521a73'
GUARD_PATH = 'tools/office-account-guard/migrations/20260909024020_require_eligible_staff_auth_account.sql'
GUARD_SHA256 = '7530eb7cd955ec1522943a179aebc03088a3ebc8126a4f4300e08eb5695bdc7b'
GUARD_MANIFEST_PATH = 'tools/office-account-guard/manifest.json'
GUARD_MANIFEST_SHA256 = 'e87f7c2ce4fccb412a9ca524dbbffde756ad20fadb09a18a8fd8c7a8a7b6b573'

# A private import reuses the reviewed source/path/write guards, never its CLI.
spec = importlib.util.spec_from_file_location('account_guard_preparation_base', REPO / 'tools/office-current-rehearsal/prepare.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
PrepareError, require, sha = p.PrepareError, p.require, p.sha
MIGRATIONS = p.MIGRATIONS + ((Path(GUARD_PATH).name, GUARD_SHA256),)
VERSIONS = tuple(name[:14] for name, _ in MIGRATIONS)
SOURCE_CONFIG_SHA256 = p.SOURCE_CONFIG_SHA256


def source_config(source):
    """Only isolate the reviewed seven-migration config to the fixed new ports."""
    baseline = p.current_config(source)
    original = tomllib.loads(baseline.decode())
    text = baseline.decode().replace('project_id = "' + p.PROJECT + '"', 'project_id = "' + PROJECT + '"', 1)
    text = re.sub(r'\b555(\d{2})\b', r'558\1', text).replace(':8830', ':8833')

    def remap(value):
        if isinstance(value, dict):
            return {key: remap(item) for key, item in value.items()}
        if isinstance(value, list):
            return [remap(item) for item in value]
        if type(value) is int and 55500 <= value <= 55599:
            return value + 300
        if isinstance(value, str):
            return value.replace(':8830', ':8833')
        return value

    expected = remap(copy.deepcopy(original))
    expected['project_id'] = PROJECT
    parsed = tomllib.loads(text)
    require(parsed == expected and parsed['auth']['enable_signup'] is False
            and parsed['auth']['email']['enable_signup'] is True, 'GUARD_CONFIG_TRANSFORM_REFUSED')
    result = text.encode()
    require(sha(result) == CONFIG_SHA256, 'GUARD_CONFIG_HASH_REFUSED')
    return result


def payloads():
    previous = p.REPO
    try:
        p.REPO = REPO
        files = p.payloads()  # Seven independent source pins and their reviewed dependency chain.
    finally:
        p.REPO = previous
    files['supabase/config.toml'] = source_config(p.read_source(REPO / 'tools/office-local-stack/config.toml'))
    manifest_bytes = p.read_source(REPO / GUARD_MANIFEST_PATH)
    require(sha(manifest_bytes) == GUARD_MANIFEST_SHA256, 'GUARD_MANIFEST_HASH_REFUSED')
    manifest = json.loads(manifest_bytes)
    require(manifest['format_version'] == 1 and manifest['state'] == 'prepared_not_applied'
            and manifest['baseline_manifest_sha256'] == sha(p.read_source(REPO / 'tools/office-preflight/manifest.json'))
            and manifest['migration'] == {'path': GUARD_PATH, 'sha256': GUARD_SHA256}
            and manifest['changes'] == ['private.current_staff_role definition only']
            and manifest['active_migration_manifest_changed'] is False and manifest['hosted_applied'] is False,
            'GUARD_MANIFEST_REFUSED')
    require(sorted(path.name for path in (REPO / Path(GUARD_PATH).parent).iterdir()) == [Path(GUARD_PATH).name],
            'GUARD_MIGRATION_INVENTORY_REFUSED')
    migration = p.read_source(REPO / GUARD_PATH)
    require(sha(migration) == GUARD_SHA256, 'GUARD_MIGRATION_HASH_REFUSED')
    files['supabase/migrations/' + Path(GUARD_PATH).name] = migration
    files['account-guard-manifest.json'] = manifest_bytes
    return files


def preparation_report(files):
    return {
        'format_version': 1, 'status': 'prepared_not_started', 'project_id': PROJECT,
        'ports': dict(PORTS), 'source_config_sha256': SOURCE_CONFIG_SHA256,
        'config_sha256': sha(files['supabase/config.toml']),
        'guard_manifest_sha256': GUARD_MANIFEST_SHA256,
        'migration_count': 8, 'payload_file_count': 10, 'output_file_count': 11,
        'migration_versions': list(VERSIONS),
        'files': [{'path': path, 'sha256': sha(data), 'bytes': len(data)} for path, data in files.items()],
        'started': False, 'hosted_calls': False,
    }


def report_bytes(report):
    return (json.dumps(report, indent=2) + '\n').encode()


def prepare(destination=None):
    """Exclusively create the fixed new private parent and eleven stack files."""
    opened = []
    try:
        destination = DESTINATION if destination is None else Path(destination)
        require(destination == DESTINATION and destination.is_absolute() and '..' not in destination.parts,
                'FIXED_SOURCE_DESTINATION_REQUIRED')
        require(not destination.is_relative_to(REPO) and not REPO.is_relative_to(destination), 'SOURCE_REPOSITORY_REFUSED')
        private = destination.parent
        parent = p.directory_fd(private.parent)
        opened.append(parent)
        require(not p.git_ancestor(private.parent), 'REPOSITORY_DESTINATION_REFUSED')
        require(not os.path.lexists(private), 'PRIVATE_DESTINATION_EXISTS')
        files = payloads()  # Validate every source before any destination creation.
        report = preparation_report(files)
        directories = {}
        for name, parent_fd, key in [(private.name, parent, 'private')]:
            os.mkdir(name, mode=0o700, dir_fd=parent_fd)
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
            opened.append(fd)
            os.fchmod(fd, 0o700)
            directories[key] = fd
        for name, parent_key, key in [(destination.name, 'private', ''), ('supabase', '', 'supabase'),
                                     ('migrations', 'supabase', 'supabase/migrations')]:
            os.mkdir(name, mode=0o700, dir_fd=directories[parent_key])
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directories[parent_key])
            opened.append(fd)
            os.fchmod(fd, 0o700)
            directories[key] = fd
        for path, data in files.items():
            parent_key = str(Path(path).parent)
            p.write_exclusive(directories['' if parent_key == '.' else parent_key], Path(path).name, data)
        p.write_exclusive(directories[''], 'preparation.json', report_bytes(report))
        return report
    except PrepareError:
        raise
    except Exception:
        # Preserve any partial directory; never delete, overwrite, or reuse it.
        raise PrepareError('SOURCE_PREPARATION_FAILED') from None
    finally:
        for fd in reversed(opened):
            os.close(fd)


def verify_prepared_source():
    """Recheck owned payloads and exactly eight SQL files, without starting services."""
    opened = []
    try:
        require(DESTINATION.is_absolute() and '..' not in DESTINATION.parts
                and not DESTINATION.is_relative_to(REPO) and not REPO.is_relative_to(DESTINATION),
                'FIXED_SOURCE_DESTINATION_REQUIRED')
        require(not p.git_ancestor(DESTINATION.parent.parent), 'REPOSITORY_DESTINATION_REFUSED')
        for path in [DESTINATION.parent, DESTINATION, DESTINATION / 'supabase', DESTINATION / 'supabase/migrations']:
            fd = p.directory_fd(path)
            opened.append(fd)
            info = os.fstat(fd)
            require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700, 'PRIVATE_SOURCE_DIRECTORY_REQUIRED')
        files = payloads()
        require(sorted(path.name for path in (DESTINATION / 'supabase/migrations').iterdir()) == [name for name, _ in MIGRATIONS],
                'PREPARED_MIGRATION_INVENTORY_REFUSED')
        # The local CLI may create other .temp metadata, but a hosted link is forbidden.
        link = DESTINATION / 'supabase/.temp/project-ref'
        require(not link.exists() and not link.is_symlink(), 'LINKED_GUARD_SOURCE_REFUSED')
        report = preparation_report(files)
        for name, data in {**files, 'preparation.json': report_bytes(report)}.items():
            path = DESTINATION / name
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid()
                    and stat.S_IMODE(info.st_mode) == 0o600, 'PRIVATE_SOURCE_FILE_REQUIRED')
            require(p.read_source(path) == data, 'PREPARED_SOURCE_BYTES_CHANGED')
        return {'config_sha256': CONFIG_SHA256, 'migration_count': 8, 'guard_manifest_sha256': GUARD_MANIFEST_SHA256}
    except PrepareError:
        raise
    except Exception:
        raise PrepareError('PREPARED_SOURCE_UNVERIFIED') from None
    finally:
        for fd in reversed(opened):
            os.close(fd)


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    try:
        require(args in (['--prepare'], ['--prepare', '--json']), 'EXACT_USAGE_REQUIRED')
        print(json.dumps(prepare(), indent=2))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, PrepareError) and re.fullmatch('[A-Z_]{1,80}', str(error)) else 'SOURCE_PREPARATION_FAILED'
        print(json.dumps({'status': 'refused', 'error': code, 'started': False, 'hosted_calls': False}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
