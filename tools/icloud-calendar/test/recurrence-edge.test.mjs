import test from 'node:test';
import assert from 'node:assert/strict';
import { convertCalendar } from '../convert.mjs';

// These fixtures are invented. No feed URL or downloaded calendar is read here.
const SEPTEMBER_NOW = new Date('2026-09-06T00:00:00Z');
const event = (...lines) => ['BEGIN:VEVENT', 'DTSTAMP:20260906T000000Z', ...lines, 'END:VEVENT'].join('\r\n');
const calendar = (...blocks) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic Recurrence QA//EN', ...blocks, 'END:VCALENDAR', ''].join('\r\n');

function rows(result) {
  assert(result && result.feed && Array.isArray(result.feed.events), 'convertCalendar must return feed.events');
  return result.feed.events;
}

function minutes(value) {
  const text = String(value).toLowerCase().replace(/\s+/g, '');
  const twelveHour = /^(1[0-2]|[1-9])(?::([0-5]\d))?([ap])m?$/.exec(text);
  if (twelveHour) return (+twelveHour[1] % 12 + (twelveHour[3] === 'p' ? 12 : 0)) * 60 + +(twelveHour[2] || 0);
  const twentyFourHour = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  assert(twentyFourHour, `Expected a real start time, received ${JSON.stringify(value)}`);
  return +twentyFourHour[1] * 60 + +twentyFourHour[2];
}

function schedule(result) {
  return rows(result).map(item => [item.when, minutes(item.time)])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
}

test('embedded VTIMEZONE keeps weekly Eastern events at 8 AM in Chicago across the November DST change', async () => {
  const timezone = [
    'BEGIN:VTIMEZONE', 'TZID:America/New_York',
    'BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZNAME:EDT', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZNAME:EST', 'END:STANDARD', 'END:VTIMEZONE'
  ].join('\r\n');
  const source = calendar(timezone, event(
    'UID:dst-only@example.test', 'SUMMARY:Prayer Meeting',
    'DTSTART;TZID=America/New_York:20261025T090000',
    'DTEND;TZID=America/New_York:20261025T100000',
    'RRULE:FREQ=WEEKLY;COUNT=3'
  ));
  const result = await convertCalendar(source, { now: new Date('2026-10-24T00:00:00Z'), horizonDays: 20 });
  assert.deepEqual(schedule(result), [['2026-10-25', 480], ['2026-11-01', 480], ['2026-11-08', 480]]);
});

test('a detached occurrence moved in from a far-future recurrence ID is included within the horizon', async () => {
  const source = calendar(
    event('UID:moved-in@example.test', 'SUMMARY:Prayer Meeting',
      'DTSTART:20260106T180000Z', 'DTEND:20260106T190000Z', 'RRULE:FREQ=WEEKLY;COUNT=52'),
    event('UID:moved-in@example.test', 'SUMMARY:Prayer Meeting', 'SEQUENCE:2',
      'RECURRENCE-ID:20261201T180000Z', 'DTSTART:20260909T200000Z', 'DTEND:20260909T210000Z')
  );
  const result = await convertCalendar(source, { now: SEPTEMBER_NOW, horizonDays: 14 });
  assert.deepEqual(schedule(result), [['2026-09-08', 780], ['2026-09-09', 900], ['2026-09-15', 780]]);
});

test('a cancellation tombstone without DTSTART suppresses its original occurrence without aborting conversion', async () => {
  const source = calendar(
    event('UID:cancelled-instance@example.test', 'SUMMARY:Prayer Meeting',
      'DTSTART:20260906T150000Z', 'DTEND:20260906T160000Z', 'RRULE:FREQ=DAILY;COUNT=3'),
    event('UID:cancelled-instance@example.test', 'RECURRENCE-ID:20260907T150000Z', 'SEQUENCE:2', 'STATUS:CANCELLED')
  );
  const result = await convertCalendar(source, { now: SEPTEMBER_NOW, horizonDays: 5 });
  assert.deepEqual(schedule(result), [['2026-09-06', 600], ['2026-09-08', 600]]);
});

test('an explicit moved override takes precedence over EXDATE for its original slot and renders once', async () => {
  const source = calendar(
    event('UID:exdate-with-override@example.test', 'SUMMARY:Prayer Meeting',
      'DTSTART:20260906T150000Z', 'DTEND:20260906T160000Z',
      'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE:20260907T150000Z'),
    event('UID:exdate-with-override@example.test', 'SUMMARY:Prayer Meeting', 'SEQUENCE:2',
      'RECURRENCE-ID:20260907T150000Z', 'DTSTART:20260907T170000Z', 'DTEND:20260907T180000Z')
  );
  const result = await convertCalendar(source, { now: SEPTEMBER_NOW, horizonDays: 5 });
  assert.deepEqual(schedule(result), [['2026-09-06', 600], ['2026-09-07', 720], ['2026-09-08', 600]]);
});

test('same-UID overrides replace only their own occurrence when another UID shares the recurrence date', async () => {
  const source = calendar(
    event('UID:series-a@example.test', 'SUMMARY:Prayer Meeting',
      'DTSTART:20260906T150000Z', 'DTEND:20260906T160000Z', 'RRULE:FREQ=DAILY;COUNT=2'),
    event('UID:series-b@example.test', 'SUMMARY:Youth',
      'DTSTART:20260906T150000Z', 'DTEND:20260906T160000Z', 'RRULE:FREQ=DAILY;COUNT=2'),
    event('UID:series-a@example.test', 'SUMMARY:Prayer Meeting', 'SEQUENCE:2',
      'RECURRENCE-ID:20260907T150000Z', 'DTSTART:20260907T170000Z', 'DTEND:20260907T180000Z')
  );
  const result = await convertCalendar(source, { now: SEPTEMBER_NOW, horizonDays: 4 });
  assert.deepEqual(schedule(result), [['2026-09-06', 600], ['2026-09-06', 600], ['2026-09-07', 600], ['2026-09-07', 720]]);
  const changedDay = rows(result).filter(item => item.when === '2026-09-07');
  assert.equal(new Set(changedDay.map(item => item.title)).size, 2, 'The unrelated Youth occurrence keeps its identity');
});

test('bounded THISANDFUTURE expansion shifts the selected and later occurrences without duplicates', async () => {
  const source = calendar(
    event('UID:range-change@example.test', 'SUMMARY:Youth',
      'DTSTART:20260906T150000Z', 'DTEND:20260906T160000Z', 'RRULE:FREQ=DAILY;COUNT=5'),
    event('UID:range-change@example.test', 'SUMMARY:Youth', 'SEQUENCE:2',
      'RECURRENCE-ID;RANGE=THISANDFUTURE:20260908T150000Z',
      'DTSTART:20260908T160000Z', 'DTEND:20260908T170000Z')
  );
  const result = await convertCalendar(source, { now: SEPTEMBER_NOW, horizonDays: 6 });
  assert.deepEqual(schedule(result), [['2026-09-06', 600], ['2026-09-07', 600], ['2026-09-08', 660], ['2026-09-09', 660], ['2026-09-10', 660]]);
});
