import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../admin/tests/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const { consumeRedirect, settings } = require('../../js/connection.js');
const manifest = JSON.parse(await readFile(new URL('manifest.json', import.meta.url), 'utf8'));
const callback = 'https://church.example.invalid/connection.html';
const config = { supabaseUrl: 'https://sampleproject.supabase.co', publishableKey: 'sb_publishable_synthetic', allowedOrigins: [new URL(callback).origin] };

for (const entry of manifest.templates) {
  test(entry.kind + ': retains only the provider confirmation URL and inert, private email markup', async () => {
    const html = await readFile(new URL(entry.file, import.meta.url), 'utf8');
    const variables = html.match(/\{\{[\s\S]*?\}\}/g);
    assert.deepEqual(variables, Array(3).fill('{{ .ConfirmationURL }}'));
    const type = entry.kind === 'confirmation' ? 'signup' : 'magiclink';
    const fixture = 'https://project.example.invalid/auth/v1/verify?token=synthetic&type=' + type + '&redirect_to=' + encodeURIComponent(callback);
    const dom = new JSDOM(html.replaceAll('{{ .ConfirmationURL }}', fixture.replaceAll('&', '&amp;')));
    const doc = dom.window.document, links = [...doc.querySelectorAll('a')];
    assert.equal(links.length, 2);
    assert(links.every(link => link.href === fixture));
    assert.equal(links[1].textContent, fixture, 'copy/paste fallback must keep the complete provider link');
    assert.equal(doc.querySelectorAll('script,iframe,form,input,object,embed,link,base,img,svg').length, 0);
    assert.equal(doc.querySelectorAll('[src],[srcset],[background]').length, 0);
    assert(!/url\s*\(|@import/i.test(html));
    assert([...doc.querySelectorAll('*')].every(el => [...el.attributes].every(attr => !/^on/i.test(attr.name))));
    assert.equal(doc.documentElement.lang, 'en');
    assert.equal(doc.querySelectorAll('h1').length, 1);
    assert(doc.querySelector('meta[name="viewport"]'));
    assert([...doc.querySelectorAll('table')].every(table => table.getAttribute('role') === 'presentation'));
    assert(entry.subject.length > 0 && !/[\r\n\x00-\x1f\x7f{}]/.test(entry.subject));
    assert(!/\b(?:sb_secret_|sb_publishable_|access_token=|refresh_token=)/.test(html));
    dom.window.close();
  });
}

test('the provider callback types reach the existing implicit public handler without a staff or token-hash detour', () => {
  assert.equal(settings(config, new URL(callback)).redirect, callback);
  for (const type of ['signup', 'magiclink', 'email']) {
    const location = new URL(callback + '#access_token=synthetic-access&refresh_token=synthetic-refresh&token_type=bearer&type=' + type);
    const changes = [];
    const tokens = consumeRedirect({ location, history: { replaceState(_state, _title, url) { changes.push(url); } } });
    assert.deepEqual(tokens, { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' });
    assert.deepEqual(changes, ['/connection.html'], 'tokens must be removed before SDK use');
  }
  for (const type of ['invite', 'recovery']) {
    const location = new URL(callback + '#access_token=synthetic-access&refresh_token=synthetic-refresh&token_type=bearer&type=' + type);
    assert.deepEqual(consumeRedirect({ location, history: { replaceState() {} } }), { error: true });
  }
});

test('prepared public templates are outside static releases and do not claim hosted configuration', async () => {
  const release = JSON.parse(await readFile(new URL('../office-release/manifest.json', import.meta.url), 'utf8'));
  assert(release.files.every(path => !path.startsWith('tools/public-email/')));
  assert.equal(manifest.state, 'prepared_not_configured');
  assert.equal(manifest.email_settings_changed, false);
  assert.equal(manifest.messages_sent, false);
  assert.equal(manifest.hosted_template_routing_verified, false);
  assert.equal(new URL(manifest.intended_public_callback).pathname, '/connection.html');
  assert.equal(manifest.flow, 'implicit');
  assert.deepEqual(manifest.templates.map(entry => entry.kind).sort(), ['confirmation', 'magic_link']);
});
