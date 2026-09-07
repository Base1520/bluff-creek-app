const test = require('node:test');
const assert = require('node:assert/strict');
const { initialize, draft } = require('../js/app-forms.js');

class Node {
  constructor() { this.hidden = true; this.dataset = {}; this.handlers = {}; this.textContent = ''; }
  addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
  emit(name) { (this.handlers[name] || []).forEach(fn => fn({ preventDefault() {} })); }
}
function form(values, required = []) {
  const result = new Node();
  const fields = Object.fromEntries(Object.entries(values).map(([name, value]) => {
    const node = new Node();
    Object.assign(node, { value: typeof value === 'string' ? value : '', checked: value === true, required: required.includes(name), validity: '', setCustomValidity(message) { this.validity = message; } });
    return [name, node];
  }));
  result.elements = Object.values(fields);
  result.elements.namedItem = name => fields[name];
  result.nativeValid = true;
  result.reportValidity = () => result.nativeValid && result.elements.every(field => !field.validity);
  return result;
}
function fixture() {
  const joinForm = form({ first: 'Example', last: '', email: 'example@example.invalid', phone: '', guest: false, texts: false, the63: false, prayer: '' }, ['first', 'email']);
  const prayForm = form({ name: '', contact: '', req: 'A synthetic test request.', private: true }, ['req']);
  const nodes = { joinForm, prayForm, joinStatus: new Node(), prayStatus: new Node(), legacyDrafts: new Node(), clearLegacyDrafts: new Node(), legacyDraftStatus: new Node() };
  const urls = [];
  const doc = { getElementById: id => nodes[id] || null, defaultView: {} };
  const storage = { getItem() { throw Error('Draft contents must not be read'); }, setItem() { throw Error('Draft contents must not be persisted'); } };
  initialize(doc, { email: 'office@example.invalid', navigate: url => urls.push(url), storage });
  return { nodes, urls, doc, storage };
}

test('native validation and trimmed required fields prevent a draft until corrected', () => {
  const f = fixture();
  f.nodes.joinForm.nativeValid = false;
  f.nodes.joinForm.emit('submit');
  assert.equal(f.urls.length, 0);
  f.nodes.joinForm.nativeValid = true;
  f.nodes.joinForm.elements.namedItem('first').value = '   ';
  f.nodes.joinForm.emit('submit');
  assert.equal(f.urls.length, 0);
  const field = f.nodes.joinForm.elements.namedItem('first');
  field.value = 'Example'; field.emit('input');
  f.nodes.joinForm.emit('submit');
  assert.equal(f.urls.length, 1);
});

test('email draft retains values and form visibility without claiming delivery or persisting contents', () => {
  const f = fixture();
  f.nodes.prayForm.emit('submit');
  assert.equal(f.urls.length, 1);
  assert.match(f.urls[0], /^mailto:office@example\.invalid\?/);
  assert.equal(f.nodes.prayForm.hidden, false);
  assert.equal(f.nodes.prayForm.elements.namedItem('req').value, 'A synthetic test request.');
  assert.equal(f.nodes.prayStatus.hidden, false);
  assert.match(f.nodes.prayStatus.textContent, /Nothing is sent by this page/);
  assert.doesNotMatch(f.nodes.prayStatus.textContent, /with our team|request is sent/);
  assert.equal(f.nodes.legacyDrafts.hidden, true);
});

test('draft encoding cannot turn a request body into extra recipients or query fields', () => {
  const f = fixture();
  f.nodes.prayForm.elements.namedItem('req').value = 'Text &bcc=other@example.invalid\nA second line';
  const url = new URL(draft(f.nodes.prayForm, 'prayer', 'office@example.invalid'));
  assert.deepEqual([...url.searchParams.keys()], ['subject', 'body']);
  assert.match(url.searchParams.get('body'), /Text &bcc=other@example.invalid\nA second line/);
});

test('unavailable email and failed handoff leave usable form values and an honest fallback', () => {
  for (const failure of ['email', 'navigation']) {
    const f = fixture();
    f.nodes.joinForm.dataset.draftReady = '';
    f.nodes.joinForm.handlers.submit = [];
    initialize(f.doc, { email: failure === 'email' ? '' : 'office@example.invalid', navigate() { throw Error('No handler'); }, storage: f.storage });
    f.nodes.joinForm.emit('submit');
    assert.equal(f.nodes.joinForm.hidden, false);
    assert.equal(f.nodes.joinForm.elements.namedItem('first').value, 'Example');
    assert.match(f.nodes.joinStatus.textContent, /entries remain/);
    assert.equal(f.urls.length, 0);
  }
});

test('legacy draft cleanup requires an explicit click and never reads stored draft contents', () => {
  const f = fixture();
  const removed = [];
  const storage = { removeItem(key) { removed.push(key); } };
  Object.defineProperty(storage, 'creek_join', { get() { throw Error('Must not read contents'); } });
  Object.defineProperty(storage, 'creek_prayer', { get() { throw Error('Must not read contents'); } });
  initialize(f.doc, { email: 'office@example.invalid', storage });
  assert.equal(f.nodes.legacyDrafts.hidden, false);
  assert.deepEqual(removed, []);
  f.nodes.clearLegacyDrafts.emit('click');
  assert.deepEqual(removed, ['creek_join', 'creek_prayer']);
  assert.match(f.nodes.legacyDraftStatus.textContent, /cleared from this device/);
});
