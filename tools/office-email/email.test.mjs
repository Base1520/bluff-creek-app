import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../admin/tests/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const manifest = JSON.parse(await readFile(new URL('manifest.json', import.meta.url), 'utf8'));
for (const entry of manifest.templates) {
  test(entry.kind + ': preserves supported single-use link and inert email content', async () => {
    const html = await readFile(new URL(entry.file, import.meta.url), 'utf8');
    const variables = html.match(/\{\{[\s\S]*?\}\}/g);
    assert.deepEqual(variables, Array(3).fill('{{ .ConfirmationURL }}'));
    const fixture = 'https://example.invalid/auth/v1/verify?token=synthetic&type=' + entry.kind + '&redirect_to=https%3A%2F%2Fexample.invalid%2Fadmin%2Frecovery.html';
    const rendered = html.replaceAll('{{ .ConfirmationURL }}', fixture.replaceAll('&', '&amp;'));
    const dom = new JSDOM(rendered);
    const doc = dom.window.document, links = [...doc.querySelectorAll('a')];
    assert.equal(links.length, 2);
    assert(links.every(a => a.href === fixture));
    assert.equal(links[1].textContent, fixture);
    assert.equal(doc.querySelectorAll('script,iframe,form,input,object,embed,link,base,img,svg').length, 0);
    assert.equal(doc.querySelectorAll('[src],[srcset],[background]').length, 0);
    assert(!/url\s*\(|@import/i.test(html));
    assert([...doc.querySelectorAll('*')].every(el => [...el.attributes].every(a => !/^on/i.test(a.name))));
    assert.equal(doc.documentElement.lang, 'en');
    assert.equal(doc.querySelectorAll('h1').length, 1);
    assert(doc.querySelector('meta[name="viewport"]'));
    assert([...doc.querySelectorAll('table')].every(t => t.getAttribute('role') === 'presentation'));
    assert(entry.subject.length > 0 && !/[\r\n]/.test(entry.subject));
    assert(!html.includes('.Email') && !html.includes('.Data'));
    dom.window.close();
  });
}
test('email preparation does not enter the public/static release inventory', async () => {
  const release = await readFile(new URL('../office-release/manifest.json', import.meta.url), 'utf8');
  assert(!release.includes('office-email'));
  assert.equal(manifest.state, 'prepared_not_configured');
  assert.equal(manifest.email_settings_changed, false);
  assert.equal(manifest.messages_sent, false);
});
