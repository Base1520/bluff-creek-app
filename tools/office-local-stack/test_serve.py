import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('office_preview', Path(__file__).with_name('serve.py'))
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


def token(role):
    payload = base64.urlsafe_b64encode(json.dumps({'role': role}).encode()).decode().rstrip('=')
    return 'synthetic.' + payload + '.signature'


class PreviewGuards(unittest.TestCase):
    def test_only_browser_safe_config_is_returned(self):
        config, origins = preview.preview_config({'API_URL':'http://127.0.0.1:55321','PUBLISHABLE_KEY':'sb_publishable_synthetic','SECRET_KEY':'must-never-reach-a-page','SERVICE_ROLE_KEY':token('service_role')}, 8810)
        self.assertEqual(set(config), {'supabaseUrl', 'publishableKey', 'localDevelopment'})
        self.assertNotIn('must-never', json.dumps(config))
        self.assertEqual(origins, ['http://127.0.0.1:8810','http://localhost:8810'])

    def test_service_and_malformed_keys_cannot_be_served(self):
        for value in ['sb_secret_synthetic', token('service_role'), token('authenticated'), 'invalid', '']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                preview.public_key({'ANON_KEY': value})
        self.assertEqual(preview.public_key({'ANON_KEY':token('anon')}), token('anon'))

    def test_misdirected_api_status_is_rejected(self):
        for url in ['https://project.supabase.co','http://192.168.1.2:55321','http://127.0.0.1:55322','http://user@127.0.0.1:55321','http://127.0.0.1:55321/rest/v1','http://127.0.0.1:55321?x=1','http://127.0.0.1:55321#x']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                preview.preview_config({'API_URL':url,'ANON_KEY':token('anon')}, 8810)

    def test_private_paths_traversal_and_external_symlinks_are_not_assets(self):
        with tempfile.TemporaryDirectory() as root:
            repo = (Path(root) / 'repo').resolve();repo.mkdir()
            for name in ['index.html','events.json','calendar.ics','admin/index.html','admin/tests/private.js','assets/.env','supabase/migrations/private.sql']:
                target=repo/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text('synthetic')
            outside=Path(root)/'outside.js';outside.write_text('private fixture')
            (repo/'assets/escape.js').symlink_to(outside)
            (repo/'assets/private.js').symlink_to(repo/'admin/tests/private.js')
            (repo/'assets/private-dir').symlink_to(repo/'admin/tests', target_is_directory=True)
            self.assertEqual(preview.safe_asset(repo,'/'),repo/'index.html')
            self.assertEqual(preview.safe_asset(repo,'/admin/'),repo/'admin/index.html')
            self.assertEqual(preview.safe_asset(repo,'/events.json'),repo/'events.json')
            self.assertEqual(preview.safe_asset(repo,'/calendar.ics'),repo/'calendar.ics')
            for path in ['/admin/tests/private.js','/assets/.env','/assets/%2e%2e/admin/tests/private.js','/supabase/migrations/private.sql','/assets/escape.js','/assets/private.js','/assets/private-dir/private.js','/.git/config']:
                self.assertIsNone(preview.safe_asset(repo,path),path)


if __name__ == '__main__':
    unittest.main()
