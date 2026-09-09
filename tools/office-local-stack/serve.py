#!/usr/bin/env python3
"""Loopback-only preview. Reads local CLI status in memory; never serves privileged keys."""
import argparse
import base64
import json
import mimetypes
from pathlib import Path
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit


def public_key(status):
    if not isinstance(status, dict):
        raise ValueError('Local status must be an object.')
    values = {key.lower(): value for key, value in status.items()}
    key = values.get('publishable_key') or values.get('anon_key') or ''
    if re.fullmatch(r'sb_publishable_[A-Za-z0-9_-]+', key):
        return key
    try:
        parts = key.split('.')
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
        if len(parts) == 3 and claims.get('role') == 'anon':
            return key
    except (ValueError, IndexError, TypeError):
        pass
    raise ValueError('No browser-safe local key available.')


def preview_config(status, port):
    if not isinstance(status, dict):
        raise ValueError('Local status must be an object.')
    values = {key.lower(): value for key, value in status.items()}
    raw = values.get('api_url', '')
    address = urlsplit(raw)
    if (address.scheme != 'http' or address.hostname != '127.0.0.1'
            or address.port != 55321 or address.username or address.password
            or address.path not in ('', '/') or address.query or address.fragment):
        raise ValueError('Expected this rehearsal API at http://127.0.0.1:55321.')
    config = {'supabaseUrl': 'http://127.0.0.1:55321', 'publishableKey': public_key(status), 'localDevelopment': True}
    return config, [f'http://127.0.0.1:{port}', f'http://localhost:{port}']


def safe_asset(repo, raw_path):
    repo = repo.resolve()
    path = unquote(urlsplit(raw_path).path)
    if path in ('/', '/admin/'):
        path += 'index.html'
    allowed = (path in ('/index.html', '/connection.html', '/manifest.webmanifest', '/sw.js', '/favicon.ico', '/events.json', '/calendar.ics')
               or re.fullmatch(r'/(?:css|js|assets)/[A-Za-z0-9_./ -]+', path)
               or re.fullmatch(r'/admin/[A-Za-z0-9_-]+\.(?:html|js|css)', path))
    requested = repo / path.lstrip('/')
    if any(part.is_symlink() for part in (requested, *requested.parents) if part != repo and part.is_relative_to(repo)):
        return None
    target = requested.resolve()
    if not allowed or any(part.startswith('.') for part in Path(path).parts) or not target.is_relative_to(repo) or not target.is_file():
        return None
    return target


def handler(repo, config, origins, port):
    class Preview(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Paths can carry Auth tokens. Never write access logs.

        def do_GET(self):
            if self.headers.get('Host') not in (f'127.0.0.1:{port}', f'localhost:{port}'):
                self.send_error(403)
                return
            path = urlsplit(self.path).path
            if path == '/admin/config.js':
                payload = ('window.CREEK_OFFICE_CONFIG = ' + json.dumps({**config, 'membershipSheetUrl': ''}) + ';').encode()
                mime = 'text/javascript'
            elif path == '/js/connection-config.js':
                payload = ('window.CREEK_CONNECTION_CONFIG = ' + json.dumps({**config, 'allowedOrigins': origins}) + ';').encode()
                mime = 'text/javascript'
            else:
                asset = safe_asset(repo, self.path)
                if asset is None:
                    self.send_error(404)
                    return
                payload = asset.read_bytes()
                mime = mimetypes.guess_type(asset.name)[0] or 'application/octet-stream'
                if asset.suffix == '.html':
                    payload = payload.replace(b'</title>', b' - Local rehearsal</title>', 1)
                    banner = ('<div role="note" style="position:relative;z-index:20;padding:10px 18px;'
                              'background:#eadfca;color:#17352b;text-align:center;font:600 14px system-ui;">'
                              'Demonstration &middot; Fictional records only &middot; Changes save on this Mac'
                              '</div>')
                    payload = payload.replace(b'<body>', b'<body>' + banner.encode(), 1)
            self.send_response(200)
            self.send_header('Content-Type', mime + ('; charset=utf-8' if mime.startswith('text/') else ''))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
    return Preview


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack', required=True, type=Path)
    parser.add_argument('--supabase-cli', required=True, type=Path)
    parser.add_argument('--port', type=int, default=8810, choices=[8810])
    args = parser.parse_args()
    stack = args.stack.resolve()
    config_text = (stack / 'supabase/config.toml').read_text()
    if not re.search(r'^project_id\s*=\s*"bcbc-office-rehearsal"\s*$', config_text, re.M):
        parser.error('This preview requires the dedicated bcbc-office-rehearsal local stack.')
    if (stack / 'supabase/.temp/project-ref').exists():
        parser.error('A linked project is not allowed for this local rehearsal.')
    result = subprocess.run([str(args.supabase_cli.resolve()), 'status', '--workdir', str(stack), '--output', 'json'], capture_output=True, text=True, timeout=30)
    if result.returncode:
        parser.error('Local stack status is unavailable. Start and verify the isolated stack first.')
    try:
        config, origins = preview_config(json.loads(result.stdout), args.port)
    except (ValueError, TypeError):
        parser.error('Local status did not contain the expected API and browser-safe key.')
    repo = Path(__file__).resolve().parents[2]
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler(repo, config, origins, args.port))
    print(f'Local fictional-data rehearsal: http://127.0.0.1:{args.port}/admin/', flush=True)
    # CLI status may contain privileged local keys; retain only the public config.
    del result
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
