import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
const script = await readFile(new URL('../reminder-calendar.js', import.meta.url), 'utf8');
const context = { Date }; vm.runInNewContext(script, context); const api = context.CreekReminderCalendar;
test('weekly calendar file uses floating local time, recurrence and an alert without personal records', () => {
  const text = api.build('2026-11-02', '09:00', new Date('2026-09-07T15:00:00Z'));
  assert.match(text, /DTSTART:20261102T090000\r\n/); assert.match(text, /RRULE:FREQ=WEEKLY;BYDAY=MO\r\n/);
  assert.match(text, /DTSTAMP:20260907T150000Z/); assert.match(text, /DURATION:PT15M/); assert.match(text, /TRIGGER:-PT10M/);
  assert.match(text, /CLASS:PRIVATE/); assert.doesNotMatch(text, /ATTENDEE|ORGANIZER|https?:|owner_id|TZID/);
  for (const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, 'RFC line length');
  const unfolded = text.replace(/\r\n /g, ''); assert.match(unfolded, /leaders\\nand choose/);
  assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 1);
});
test('calendar rejects invalid and past date/time input and newline injection', () => {
  const now = new Date('2026-09-07T15:00:00Z');
  for (const [date, time] of [['2026-02-30', '09:00'], ['2026-09-08', '25:00'], ['2026-09-08\r\nATTENDEE:x', '09:00'], ['2026-09-06', '09:00']]) assert.throws(() => api.build(date, time, now));
});
test('Monday suggestion advances after the proposed time, including month/year boundaries', () => {
  assert.equal(api.nextMonday(new Date(2026, 8, 7, 8)), '2026-09-07');
  assert.equal(api.nextMonday(new Date(2026, 8, 7, 10)), '2026-09-14');
  assert.equal(api.nextMonday(new Date(2026, 11, 31, 10)), '2027-01-04');
});
test('calendar preparation is explicit, revokes old files and clears on sign-out', t => {
  const dom = new JSDOM('<button id="reminder">Calendar</button>', { url: 'https://office.example.invalid/admin/', runScripts: 'outside-only' }); t.after(() => dom.window.close());
  const w = dom.window; let allowed = true, count = 0; const revoked = [];
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.URL.createObjectURL = () => 'blob:synthetic-' + (++count); w.URL.revokeObjectURL = url => revoked.push(url);
  w.eval(script); const module = w.CreekReminderCalendar.create({ button: w.document.getElementById('reminder'), allowed: () => allowed });
  module.open(); assert.equal(count, 0); const form = w.document.querySelector('form');
  form.elements.date.value = '2035-09-03'; form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.equal(count, 1); assert.equal(w.document.querySelector('[download]').download, 'creek-office-weekly-check-in.ics');
  form.elements.time.dispatchEvent(new w.Event('input')); assert.deepEqual(revoked, ['blob:synthetic-1']); assert.equal(w.document.querySelector('[download]'), null);
  form.dispatchEvent(new w.Event('submit', { cancelable: true })); allowed = false; module.clear(); module.open();
  assert.deepEqual(revoked, ['blob:synthetic-1', 'blob:synthetic-2']); assert.equal(w.document.querySelector('dialog'), null);
});
