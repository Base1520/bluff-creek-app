#!/usr/bin/env python3
"""Prepare the fixed NEW fictional recovery source; never start local services."""
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
DESTINATION = WORK / 'office-current-recovery-source-private-20260909/stack'
PROJECT = 'bcbc-office-recovery-source-v1'
PORTS = {'api': 55621, 'db': 55622, 'shadow': 55620, 'smtp': 55624, 'browser': 8831}

spec = importlib.util.spec_from_file_location('recovery_source_preparation_base', REPO / 'tools/office-current-rehearsal/prepare.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
PrepareError, require, sha = p.PrepareError, p.require, p.sha
MIGRATIONS = p.MIGRATIONS
SOURCE_CONFIG_SHA256 = p.SOURCE_CONFIG_SHA256
_original_config = p.current_config


def source_config(source):
    """Retain the reviewed global-signup-off/email-provider-on transformation."""
    baseline = _original_config(source)
    original = tomllib.loads(baseline.decode())
    text = baseline.decode().replace('project_id = "' + p.PROJECT + '"', 'project_id = "' + PROJECT + '"', 1)
    text = re.sub(r'\b555(\d{2})\b', r'556\1', text).replace(':8830', ':8831')

    def remap(value):
        if isinstance(value, dict):
            return {key: remap(item) for key, item in value.items()}
        if isinstance(value, list):
            return [remap(item) for item in value]
        if type(value) is int and 55500 <= value <= 55599:
            return value + 100
        if isinstance(value, str):
            return value.replace(':8830', ':8831')
        return value

    expected = remap(copy.deepcopy(original))
    expected['project_id'] = PROJECT
    parsed = tomllib.loads(text)
    require(parsed == expected and parsed['auth']['enable_signup'] is False
            and parsed['auth']['email']['enable_signup'] is True, 'RECOVERY_CONFIG_TRANSFORM_REFUSED')
    return text.encode()


def payloads():
    previous = p.REPO
    try:
        p.REPO = REPO
        files = p.payloads()  # Independently pinned seven paths, SQL bytes and dependency chain.
        files['supabase/config.toml'] = source_config(p.read_source(REPO / 'tools/office-local-stack/config.toml'))
        return files
    finally:
        p.REPO = previous


def verify_prepared_source():
    """Read-only physical/private source check, also used before later seeding."""
    root = DESTINATION.parent
    opened = []
    try:
        for path in [root, DESTINATION, DESTINATION / 'supabase', DESTINATION / 'supabase/migrations']:
            fd = p.directory_fd(path)
            opened.append(fd)
            info = os.fstat(fd)
            require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700, 'PRIVATE_SOURCE_DIRECTORY_REQUIRED')
        expected = payloads()
        require(sorted(path.name for path in (DESTINATION / 'supabase/migrations').glob('*.sql')) == [name for name, _ in MIGRATIONS], 'PREPARED_MIGRATION_INVENTORY_REFUSED')
        link = DESTINATION / 'supabase/.temp/project-ref'
        require(not link.exists() and not link.is_symlink(), 'LINKED_RECOVERY_SOURCE_REFUSED')
        for name, data in expected.items():
            path = DESTINATION / name
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid()
                    and stat.S_IMODE(info.st_mode) == 0o600, 'PRIVATE_SOURCE_FILE_REQUIRED')
            require(p.read_source(path) == data, 'PREPARED_SOURCE_BYTES_CHANGED')
        return {'config_sha256': sha(expected['supabase/config.toml']), 'migration_count': 7}
    except PrepareError:
        raise
    except Exception:
        raise PrepareError('PREPARED_SOURCE_UNVERIFIED') from None
    finally:
        for fd in reversed(opened):
            os.close(fd)


def prepare(destination=None):
    """Create only the fixed new private parent and its nine-file stack."""
    destination = DESTINATION if destination is None else Path(destination)
    require(destination == DESTINATION and destination.is_absolute() and '..' not in destination.parts,
            'FIXED_SOURCE_DESTINATION_REQUIRED')
    require(not destination.is_relative_to(REPO) and not REPO.is_relative_to(destination), 'SOURCE_REPOSITORY_REFUSED')
    private = destination.parent
    descriptor = p.directory_fd(private.parent)
    previous = (p.REPO, p.PROJECT, p.PORTS, p.payloads)
    try:
        require(not p.git_ancestor(private.parent), 'REPOSITORY_DESTINATION_REFUSED')
        require(not os.path.lexists(private), 'PRIVATE_DESTINATION_EXISTS')
        files = payloads()  # Refuse drift before creating any directory.
        os.mkdir(private.name, mode=0o700, dir_fd=descriptor)
        private_fd = os.open(private.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
        try:
            os.fchmod(private_fd, 0o700)
        finally:
            os.close(private_fd)
        p.REPO, p.PROJECT, p.PORTS = REPO, PROJECT, dict(PORTS)
        p.payloads = lambda: files
        return p.prepare(destination)
    except PrepareError:
        raise
    except Exception:
        # A partial private folder is preserved; never remove, overwrite or reuse it.
        raise PrepareError('SOURCE_PREPARATION_FAILED') from None
    finally:
        p.REPO, p.PROJECT, p.PORTS, p.payloads = previous
        os.close(descriptor)


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    try:
        require(args in (['--prepare'], ['--prepare', '--json']), 'EXACT_USAGE_REQUIRED')
        report = prepare()
        print(json.dumps(report, indent=2))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, PrepareError) and re.fullmatch('[A-Z_]{1,80}', str(error)) else 'SOURCE_PREPARATION_FAILED'
        print(json.dumps({'status': 'refused', 'error': code, 'started': False, 'hosted_calls': False}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
