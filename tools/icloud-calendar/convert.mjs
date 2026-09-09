/* Pure, local-input calendar conversion. No raw source fields leave this module. */
import ICAL from 'ical.js';

const ZONE = 'America/Chicago';
const DAY = 86400000;
const LIMITS = Object.freeze({bytes: 2 * 1024 * 1024, components: 10000, iterations: 250000, perSeries: 25000, events: 5000});
const TITLES = new Map([
  ['Business Meeting', 'Business meeting'], ['Prayer Meeting', 'Prayer meeting'],
  ['Sunday School & Morning Worship', 'Sunday School & Morning Worship'],
  ['Sunday Morning Prayer', 'Sunday morning prayer'], ['Sunday Evening Discipleship', 'Sunday evening discipleship'],
  ['Yoga at BCBC', 'Yoga @ the Creek'], ['WMU Meeting', 'WMU'], ['Youth', 'Youth @ the Creek'],
  ['Youth YEC', 'Youth YEC'], ["Youth Friend'sGiving Potluck", 'Youth Friendsgiving potluck'],
  ['Youth - Christmas Party', 'Youth Christmas party'], ["Women's Bible Study", 'Women’s Bible study']
].map(([source, title]) => [normalize(source), title]));

export class ImportError extends Error {
  constructor(code = 'INVALID_CALENDAR') { super('Calendar import failed validation. Previous output was not changed.'); this.name = 'ImportError'; this.code = code; }
}
function fail(code) { throw new ImportError(code); }
function normalize(value) { return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : ''; }
function value(component, name) { return component.getFirstPropertyValue(name); }
function suppressed(component) { return /cancelled|canceled/i.test(String(value(component, 'summary') || '')) || String(value(component, 'status') || '').toUpperCase() === 'CANCELLED' || ['PRIVATE', 'CONFIDENTIAL'].includes(String(value(component, 'class') || '').toUpperCase()); }
function titleFor(component) { return suppressed(component) ? null : TITLES.get(normalize(value(component, 'summary'))) || null; }
const VERIFIED_ROOMS = new Map([
  ['Yoga @ the Creek','Fellowship Building'],['Prayer meeting','Sanctuary'],
  ['Youth @ the Creek','Fellowship Building'],['WMU','Fellowship Hall'],
  ['Sunday School & Morning Worship','Fellowship building & sanctuary'],
  ['Sunday evening discipleship','Sanctuary']
]);
function publicLocation(component, title) {
  const location = normalize(value(component, 'location')).replace(/[.,]/g, '');
  const church = /^(?:bluff creek baptist church|sanctuary|fellowship building|fellowship hall)$/.test(location) || /^1706 (?:highway|hwy|la[- ]?) ?63(?:\b|$)/.test(location);
  if (church) return 'Bluff Creek Baptist Church';
  if (!location && VERIFIED_ROOMS.has(title)) return VERIFIED_ROOMS.get(title);
  return 'Check with the church for location';
}
function dateString(date) { return date.toISOString().slice(0, 10); }
function addDays(date, count) { return dateString(new Date(Date.parse(date + 'T12:00:00Z') + count * DAY)); }
function formatters() {
  const date = new Intl.DateTimeFormat('en-CA', {timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit'});
  const time = new Intl.DateTimeFormat('en-US', {timeZone: ZONE, hourCycle: 'h23', hour: '2-digit', minute: '2-digit'});
  const parts = (f, instant) => Object.fromEntries(f.formatToParts(new Date(instant)).map(p => [p.type, p.value]));
  return {date(instant) { const p = parts(date, instant); return `${p.year}-${p.month}-${p.day}`; }, time(instant) { const p = parts(time, instant), h = +p.hour; return `${h % 12 || 12}:${p.minute}${h >= 12 ? 'p' : 'a'}`; }};
}
function wallUTC(t) { const d = new Date(0); d.setUTCFullYear(t.year, t.month - 1, t.day); d.setUTCHours(t.hour || 0, t.minute || 0, t.second || 0, 0); return +d; }
function floatingEpoch(time) {
  const wall = wallUTC(time), f = new Intl.DateTimeFormat('en-US', {timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit'});
  function fields(instant) { const p = Object.fromEntries(f.formatToParts(new Date(instant)).map(p => [p.type, p.value])); return {year:+p.year,month:+p.month,day:+p.day,hour:+p.hour,minute:+p.minute,second:+p.second}; }
  const offsets = new Set([-36,-12,12,36].map(h => {const at = wall + h * 3600000; return wallUTC(fields(at)) - at;}));
  const candidates = [...offsets].map(offset => wall - offset);
  const matching = candidates.filter(instant => wallUTC(fields(instant)) === wall);
  // RFC 5545: first instance in an overlap; pre-gap offset for nonexistent wall time.
  return matching.length ? Math.min(...matching) : Math.max(...candidates);
}
function instant(time) { return time.zone?.tzid === 'floating' ? floatingEpoch(time) : time.toUnixTime() * 1000; }
function validWallTime(time) {
  if (time.isDate) return true;
  const at = instant(time);
  let back;
  if (time.zone?.tzid === 'floating') {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',hourCycle:'h23',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(new Date(at)).map(p=>[p.type,p.value]));
    back = {year:+p.year,month:+p.month,day:+p.day,hour:+p.hour,minute:+p.minute,second:+p.second};
  } else back = ICAL.Time.fromJSDate(new Date(at),true).convertToZone(time.zone);
  return ['year','month','day','hour','minute','second'].every(field=>time[field]===back[field]);
}
function recurrenceKey(time) { return time.isDate ? `date:${time.toString()}` : `time:${instant(time)}`; }
function revision(component) { const seq = Number(value(component, 'sequence') || 0); const stamp = value(component, 'last-modified') || value(component, 'dtstamp'); return [Number.isFinite(seq) ? seq : 0, stamp ? stamp.toString() : '']; }
function latest(a, b) { if (!a) return b; const ar = revision(a), br = revision(b); return br[0] > ar[0] || (br[0] === ar[0] && br[1] >= ar[1]) ? b : a; }
function validateRawDate(source) {
  if (typeof source !== 'string') fail();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})Z?)?$/.exec(source);
  if (!m || +m[1] < 1 || +m[4] > 23 || +m[5] > 59 || +m[6] > 59) fail();
  const d = new Date(0); d.setUTCFullYear(+m[1], +m[2]-1, +m[3]);
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth()+1 !== +m[2] || d.getUTCDate() !== +m[3]) fail();
}
function validateDates(component, calendar) {
  for (const property of component.getAllProperties()) {
    if (!['date', 'date-time'].includes(property.type)) continue;
    for (const raw of property.toJSON().slice(3)) validateRawDate(raw);
    const tzid = property.getParameter('tzid');
    // Named zones must have explicit definitions; no silent fallback to local time.
    if (tzid && tzid !== 'UTC' && !calendar.getTimeZoneByID(tzid)) fail('UNRESOLVED_TIMEZONE');
    property.getValues();
  }
}
function validateRules(component, cap) {
  if (component.getAllProperties('rrule').length > 16 || ['rdate','exdate'].reduce((sum,name)=>sum+component.getAllProperties(name).reduce((n,p)=>n+p.toJSON().length-3,0),0) > 10000) fail('RECURRENCE_LIMIT');
  if (component.hasProperty('exrule')) fail('UNSUPPORTED_RECURRENCE');
  if (component.getAllProperties('rdate').some(p => p.type === 'period')) fail('UNSUPPORTED_RECURRENCE');
  for (const property of component.getAllProperties('rrule')) {
    const rule = property.getFirstValue();
    if (!['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(rule.freq) || !Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 1000) fail('RECURRENCE_LIMIT');
    if (Object.values(rule.parts).reduce((product, values) => product * Math.max(1, values.length), 1) > 512) fail('RECURRENCE_LIMIT');
    const until = ICAL.Time.fromJSDate(new Date(cap), true);
    if (value(component, 'dtstart')?.isDate) { until.isDate = true; until.hour = 0; until.minute = 0; until.second = 0; }
    if (!rule.until || rule.until.compare(until) > 0) rule.until = until;
    property.setValue(rule);
  }
}
function escapedICS(text) { return String(text).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }
function opaqueId(text) { let hash = 0xcbf29ce484222325n; for (const byte of new TextEncoder().encode(text)) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n); } return `${hash.toString(16).padStart(16,'0')}@public.bluffcreek.church`; }
function compactISO(iso) { return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function fold(line) { const lines = []; let current = '', size = 0; for (const char of line) { const n = new TextEncoder().encode(char).length; if (size + n > 75) { lines.push(current); current = ' '; size = 1; } current += char; size += n; } lines.push(current); return lines.join('\r\n'); }
function calendarICS(records, syncedAt) {
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Bluff Creek Baptist Church//Public Calendar//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
  for (const {event, startISO, endISO} of records) {
    lines.push('BEGIN:VEVENT', `UID:${opaqueId(JSON.stringify([event.title,event.when,event.time,event.endsAt || '']))}`, `DTSTAMP:${compactISO(syncedAt)}`);
    if (event.allDay) lines.push(`DTSTART;VALUE=DATE:${event.when.replace(/-/g,'')}`, `DTEND;VALUE=DATE:${event.endsAt.replace(/-/g,'')}`);
    else { lines.push(`DTSTART:${compactISO(startISO)}`); if (endISO !== startISO) lines.push(`DTEND:${compactISO(endISO)}`); }
    lines.push(`SUMMARY:${escapedICS(event.title)}`, `LOCATION:${escapedICS(event.where)}`, 'CLASS:PUBLIC', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR'); return lines.map(fold).join('\r\n') + '\r\n';
}

export function convertCalendar(sourceText, {now = new Date(), horizonDays = 90} = {}) {
  try { return convert(sourceText, {now, horizonDays}); }
  catch (error) { if (error instanceof ImportError) throw error; throw new ImportError(); }
}
function convert(sourceText, {now, horizonDays}) {
  now = new Date(now);
  if (!Number.isFinite(+now) || !Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 90) fail('INVALID_OPTIONS');
  if (typeof sourceText !== 'string' || new TextEncoder().encode(sourceText).length > LIMITS.bytes) fail('INPUT_LIMIT');
  const raw = ICAL.parse(sourceText);
  if (!Array.isArray(raw) || raw[0] !== 'vcalendar') fail();
  const calendar = new ICAL.Component(raw);
  if (String(value(calendar,'version')) !== '2.0') fail();
  const components = calendar.getAllSubcomponents('vevent');
  if (components.length > LIMITS.components) fail('INPUT_LIMIT');
  const fmt = formatters(), today = fmt.date(now), until = addDays(today, horizonDays), startWindow = floatingEpoch(ICAL.Time.fromString(today+'T00:00:00')), endWindow = floatingEpoch(ICAL.Time.fromString(until+'T00:00:00'));
  const counts = {input:components.length, series:0, skipped:0, suppressed:0, iterations:0, deduplicated:0, published:0};
  const groups = new Map();
  for (const component of components) {
    const uid = value(component,'uid');
    if (typeof uid !== 'string' || !uid.trim()) fail();
    validateDates(component, calendar);
    if (!groups.has(uid)) groups.set(uid, {master:null, exceptions:new Map()});
    const group = groups.get(uid), rid = value(component,'recurrence-id');
    if (rid) { const key = recurrenceKey(rid); group.exceptions.set(key,latest(group.exceptions.get(key),component)); }
    else group.master = latest(group.master, component);
  }
  const records = new Map();
  function emit(details, master, tag) {
    const component = details.item.component, title = titleFor(component), where = publicLocation(component, title);
    if (!title || (master && suppressed(master))) { counts.suppressed++; return; }
    const start = details.startDate, end = details.endDate;
    if (!start || !end || start.isDate !== end.isDate) fail();
    let event, startISO, endISO;
    if (start.isDate) {
      const when = start.toString(), endsAt = end.toString();
      if (endsAt <= when) fail();
      if (when >= until || endsAt <= today) return;
      event = {when,time:'All day',title,where,tag,allDay:true,endsAt};
    } else {
      if (!validWallTime(start) || !validWallTime(end)) fail('NONEXISTENT_WALL_TIME');
      const at = instant(start), to = instant(end);
      if (!Number.isFinite(at) || !Number.isFinite(to) || to < at) fail();
      if (at >= endWindow || (to > at ? to <= +now : at < +now) || to < startWindow) return;
      startISO = new Date(at).toISOString(); endISO = new Date(to).toISOString();
      event = {when:fmt.date(at),time:fmt.time(at),title,where,tag};
      if (to > at) event.endsAt = endISO;
    }
    const key = JSON.stringify([event.when,event.time,event.title,event.endsAt || '']);
    if (records.has(key)) { counts.deduplicated++; if (records.get(key).event.where !== event.where) records.get(key).event.where = 'Check with the church for location'; } else records.set(key,{event,startISO,endISO});
    if (records.size > LIMITS.events) fail('OUTPUT_LIMIT');
  }
  for (const {master,exceptions} of groups.values()) {
    counts.series++;
    if (master && !titleFor(master)) { counts.skipped += 1 + exceptions.size; continue; }
    if (!master) {
      for (const component of exceptions.values()) {
        if (!titleFor(component)) { counts.skipped++; continue; }
        const event = new ICAL.Event(component,{exceptions:[],strictExceptions:true});
        emit({item:event,startDate:event.startDate,endDate:event.endDate},null,'Special');
      }
      continue;
    }
    if (!value(master,'dtstart')) fail();
    const event = new ICAL.Event(master,{exceptions:[],strictExceptions:true});
    let backwardsShift = 0;
    for (const component of exceptions.values()) {
      const rid = value(component,'recurrence-id'), start = value(component,'dtstart');
      if (component.getFirstProperty('recurrence-id').getParameter('range') && component.getFirstProperty('recurrence-id').getParameter('range') !== 'THISANDFUTURE') fail('UNSUPPORTED_RECURRENCE');
      // Tombstones and non-public overrides still suppress their original slot.
      if (!start) { if (titleFor(component)) fail(); component.addPropertyWithValue('dtstart',rid.clone()); }
      if (!component.hasProperty('dtend') && !component.hasProperty('duration')) component.addPropertyWithValue('duration',event.duration.clone());
      if (component.getFirstProperty('recurrence-id').getParameter('range') === 'THISANDFUTURE') backwardsShift = Math.max(backwardsShift,instant(rid)-instant(value(component,'dtstart')));
      event.relateException(new ICAL.Event(component,{exceptions:[],strictExceptions:true}));
    }
    const cap = endWindow + Math.max(0,backwardsShift) + DAY;
    validateRules(master, cap);
    // RDATE-only expansion in ical.js omits DTSTART unless it is explicitly included.
    if (master.hasProperty('rdate') && !master.hasProperty('rrule')) master.addPropertyWithValue('rdate',value(master,'dtstart').clone());
    const frequency = value(master,'rrule')?.freq;
    const tag = frequency === 'WEEKLY' ? 'Weekly' : frequency === 'MONTHLY' ? 'Monthly' : 'Special';
    const iterator = event.iterator(); let next, iterations = 0;
    while ((next = iterator.next())) {
      if (++iterations > LIMITS.perSeries || ++counts.iterations > LIMITS.iterations) fail('RECURRENCE_LIMIT');
      if (instant(next) >= cap) break;
      if (!validWallTime(next)) fail('NONEXISTENT_WALL_TIME');
      const exact = exceptions.get(recurrenceKey(next));
      // Use original-ID lookup first so UTC/local representations cannot cross series.
      if (exact && !titleFor(exact)) { counts.suppressed++; continue; }
      const override = exact ? new ICAL.Event(exact,{exceptions:[],strictExceptions:true}) : null;
      const details = override ? {item:override,startDate:override.startDate,endDate:override.endDate} : event.getOccurrenceDetails(next);
      emit(details,master,tag);
    }
    // Detached moves may enter the window from an excluded or distant original slot.
    for (const component of exceptions.values()) {
      if (!titleFor(component)) continue;
      const override = new ICAL.Event(component,{exceptions:[],strictExceptions:true});
      emit({item:override,startDate:override.startDate,endDate:override.endDate},master,tag);
    }
  }
  const ordered = [...records.values()].sort((a,b) => a.event.when.localeCompare(b.event.when) || (Number(!a.event.allDay) - Number(!b.event.allDay)) || (a.startISO || '').localeCompare(b.startISO || '') || a.event.title.localeCompare(b.event.title));
  const syncedAt = now.toISOString(); counts.published = ordered.length;
  return {feed:{source:'icloud',updated:today,synced_at:syncedAt,valid_until:addDays(until,-1),recurring:[],events:ordered.map(record=>record.event)},counts,ics:calendarICS(ordered,syncedAt)};
}
