#!/usr/bin/env python3
"""Prepare a new, unlinked local rehearsal directory with verified migration copies."""
import argparse
import hashlib
import json
from pathlib import Path
import re


def prepare(destination):
    repo = Path(__file__).resolve().parents[2]
    destination = destination.resolve()
    if destination.is_relative_to(repo) or repo.is_relative_to(destination):
        raise ValueError('Choose a separate sibling directory outside the app repository.')
    if destination.exists():
        raise ValueError('Destination already exists. Reuse it explicitly; this tool never overwrites or resets a stack.')
    manifest = json.loads((repo / 'tools/office-preflight/manifest.json').read_text())
    entries = manifest['sql_files']
    inventory = sorted(path.relative_to(repo).as_posix() for path in (repo / 'supabase/migrations').glob('*.sql'))
    if inventory != [entry['path'] for entry in entries]:
        raise ValueError('Migration inventory differs from the reviewed manifest.')
    files = []
    for entry in entries:
        if not re.fullmatch(r'supabase/migrations/\d{14}_[A-Za-z0-9_]+\.sql', entry['path']):
            raise ValueError('Unexpected migration path.')
        payload = (repo / entry['path']).read_bytes()
        if hashlib.sha256(payload).hexdigest() != entry['sha256']:
            raise ValueError('Migration hash differs from the reviewed manifest.')
        files.append((entry['path'], payload))
    config = Path(__file__).with_name('config.toml').read_bytes()
    destination.mkdir(parents=True, mode=0o700)
    (destination / 'supabase/migrations').mkdir(parents=True)
    (destination / 'supabase/config.toml').write_bytes(config)
    for path, payload in files:
        (destination / path).write_bytes(payload)
    print(f'Prepared {len(files)} verified migrations in a new unlinked local stack. No services started.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    try:
        prepare(args.destination)
    except (ValueError, KeyError) as error:
        parser.error(str(error))
