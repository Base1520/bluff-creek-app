#!/usr/bin/env python3
"""Read-only integrity check of supplied private database and original-file copies."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys

REPO = Path(__file__).resolve().parents[2]
BASELINE = REPO / 'tools/office-preflight/manifest.json'
MAX_JSON = 4 * 1024 ** 2
MAX_BYTES = 2 * 1024 ** 3
MAX_ORIGINAL = 50 * 1024 ** 2
MAX_ITEMS = 1000
SHA = re.compile(r'[0-9a-f]{64}')
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}')


class Refused(Exception):
    """Only fixed codes leave this checker; never private paths or contents."""


def require(value, code='MANIFEST_INVALID'):
    if not value:
        raise Refused(code)


def exact(value, keys):
    require(isinstance(value, dict) and set(value) == set(keys))


def safe_absolute(value):
    path = Path(value)
    require(path.is_absolute() and '..' not in path.parts, 'PATH_REFUSED')
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        require(not stat.S_ISLNK(current.lstat().st_mode), 'PATH_REFUSED')
    return path


def local_file(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and not getattr(info, 'st_flags', 0) & 0x40000000, 'FILE_REFUSED')
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600, 'PRIVATE_MODE_REQUIRED')
    return info


def read_verified(path, expected_bytes=None, expected_hash=None, collect=False):
    info = local_file(path)
    limit = MAX_JSON if collect else MAX_BYTES
    require(info.st_size <= limit, 'SIZE_LIMIT')
    if expected_bytes is not None:
        require(info.st_size == expected_bytes, 'FILE_INTEGRITY_MISMATCH')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    digest, chunks, total = hashlib.sha256(), [], 0
    with os.fdopen(fd, 'rb') as source:
        opened = os.fstat(source.fileno())
        require((opened.st_dev, opened.st_ino) == (info.st_dev, info.st_ino), 'FILE_CHANGED')
        for block in iter(lambda: source.read(1024 * 1024), b''):
            total += len(block)
            require(total <= limit, 'SIZE_LIMIT')
            digest.update(block)
            if collect:
                chunks.append(block)
        after = os.fstat(source.fileno())
    current = local_file(path)
    state = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns)
    require(state(info) == state(after) == state(current) and total == info.st_size, 'FILE_CHANGED')
    if expected_hash is not None:
        require(digest.hexdigest() == expected_hash, 'FILE_INTEGRITY_MISMATCH')
    return b''.join(chunks) if collect else total


def duplicate_keys(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value)
        value[key] = item
    return value


def item_list(value):
    require(isinstance(value, list) and len(value) <= MAX_ITEMS)
    return value


def integer(value, minimum=0, maximum=MAX_BYTES):
    require(type(value) is int and minimum <= value <= maximum)
    return value


def name(value):
    require(isinstance(value, str) and 0 < len(value) <= 1024
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))
    return value


def relative(value, prefix):
    require(isinstance(value, str) and 0 < len(value) <= 512, 'PATH_REFUSED')
    path = PurePosixPath(value)
    require(not path.is_absolute() and len(path.parts) >= 2 and path.parts[0] == prefix
            and all(part not in ('', '.', '..') for part in value.split('/'))
            and '\\' not in value and not any(ord(char) < 32 or ord(char) == 127 for char in value), 'PATH_REFUSED')
    return path.as_posix()


def check_bundle(bundle, manifest):
    try:
        return _check_bundle(bundle, manifest)
    except Refused:
        raise
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, RecursionError):
        raise Refused('BUNDLE_UNREADABLE_OR_INVALID') from None


def _check_bundle(bundle, manifest):
    bundle, manifest = safe_absolute(bundle), safe_absolute(manifest)
    require(not bundle.is_relative_to(REPO) and not REPO.is_relative_to(bundle)
            and not manifest.is_relative_to(REPO), 'SOURCE_DIRECTORY_REFUSED')
    info = bundle.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o700, 'PRIVATE_MODE_REQUIRED')
    data = json.loads(read_verified(manifest, collect=True), object_pairs_hook=duplicate_keys)
    exact(data, ('format_version', 'baseline_manifest_sha256', 'database', 'objects',
                 'originals', 'documents', 'membership_sources'))
    require(data['format_version'] == 1 and type(data['format_version']) is int)
    require(data['baseline_manifest_sha256'] == hashlib.sha256(BASELINE.read_bytes()).hexdigest(), 'BASELINE_MISMATCH')
    files, kinds, total = {}, set(), 0
    for row in item_list(data['database']):
        exact(row, ('kind', 'path', 'bytes', 'sha256'))
        require(row['kind'] in ('roles', 'schema', 'data', 'migration_history', 'managed_schema_changes')
                and row['kind'] not in kinds)
        kinds.add(row['kind'])
        path = relative(row['path'], 'database')
        require(path not in files and isinstance(row['sha256'], str) and SHA.fullmatch(row['sha256']))
        total += integer(row['bytes'], 1)
        files[path] = row
    require({'roles', 'schema', 'data'} <= kinds)
    objects = {}
    for row in item_list(data['objects']):
        exact(row, ('name', 'size_bytes'))
        key = name(row['name'])
        require(key not in objects)
        objects[key] = integer(row['size_bytes'], maximum=MAX_ORIGINAL)
    originals = {}
    for row in item_list(data['originals']):
        exact(row, ('name', 'path', 'bytes', 'sha256'))
        key, path = name(row['name']), relative(row['path'], 'originals')
        require(key not in originals and path not in files)
        require(isinstance(row['sha256'], str) and SHA.fullmatch(row['sha256']))
        originals[key] = integer(row['bytes'], maximum=MAX_ORIGINAL)
        total += row['bytes']
        files[path] = row
    require(objects == originals, 'ORIGINAL_INVENTORY_MISMATCH')
    require(total <= MAX_BYTES, 'SIZE_LIMIT')
    documents, document_paths = {}, set()
    for row in item_list(data['documents']):
        exact(row, ('id', 'storage_path', 'size_bytes'))
        require(isinstance(row['id'], str) and UUID.fullmatch(row['id']) and row['id'] not in documents)
        path = name(row['storage_path'])
        require(path not in document_paths and path in objects
                and objects[path] == integer(row['size_bytes'], 1, MAX_ORIGINAL), 'DOCUMENT_OBJECT_MISMATCH')
        documents[row['id']] = path
        document_paths.add(path)
    sources = item_list(data['membership_sources'])
    for source in sources:
        require(isinstance(source, str) and UUID.fullmatch(source) and source in documents, 'SOURCE_DOCUMENT_MISSING')
    allowed_files = set(files)
    if manifest.is_relative_to(bundle):
        relative_manifest = manifest.relative_to(bundle).as_posix()
        require(relative_manifest not in allowed_files, 'MANIFEST_PAYLOAD_COLLISION')
        allowed_files.add(relative_manifest)
    allowed_dirs = {'.'}
    for value in allowed_files:
        allowed_dirs.update(str(parent) for parent in PurePosixPath(value).parents)
    found = set()
    for directory, dirs, entries in os.walk(bundle, followlinks=False):
        parent = Path(directory)
        for entry in dirs:
            path = parent / entry
            info = path.lstat()
            require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                    and path.relative_to(bundle).as_posix() in allowed_dirs, 'UNLISTED_OR_UNSAFE_ENTRY')
            require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700, 'PRIVATE_MODE_REQUIRED')
        for entry in entries:
            path = parent / entry
            local_file(path)
            found.add(path.relative_to(bundle).as_posix())
            require(len(found) <= 2 * MAX_ITEMS, 'SIZE_LIMIT')
    require(found == allowed_files, 'FILE_INVENTORY_MISMATCH')
    for value, row in files.items():
        read_verified(bundle / value, row['bytes'], row['sha256'])
    # This is intentionally a local file-integrity result, not a restore claim.
    return {'status': 'local_bundle_integrity_verified', 'database_files': len(kinds),
            'original_files': len(originals), 'original_bytes': sum(originals.values()),
            'document_records': len(documents), 'linked_sources': len(sources),
            'database_restore_verified': False, 'off_device_verified': False}


def main():
    class PrivateArgumentParser(argparse.ArgumentParser):
        def error(self, message):
            # argparse's default includes raw arguments, which may be private.
            print(json.dumps({'status': 'refused', 'error': 'ARGUMENTS_INVALID'}))
            raise SystemExit(2)

    parser = PrivateArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()
    try:
        report = check_bundle(args.bundle, args.manifest)
    except Refused as error:
        print(json.dumps({'status': 'refused', 'error': str(error)}))
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
