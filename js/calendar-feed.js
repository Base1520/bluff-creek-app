/* Shared public calendar. Keep this file identical in the website and member app.
   iCloud mode consumes only the curated public JSON, never the original private metadata. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CreekCalendar = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSYntD_RzVFtEbbz8r-IP-tQ8YvHYnrpgsCi-xRdnmQ6bEMMQd9Mryrn7UYZpyMBklrszUMrDr2fda7/pub?gid=0&single=true&output=csv';
  var FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSfcjsMhQHqRClov1oXBgkhCP_tcvWKtQyPltvYVLyVzSkj1Kg/viewform';
  var DEFAULT_FEED = {"source":"icloud","updated":"2026-09-06","synced_at":"2026-09-07T04:00:43.242Z","valid_until":"2026-12-04","recurring":[],"events":[{"when":"2026-09-08","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-08T21:30:00.000Z"},{"when":"2026-09-09","time":"6:00p","title":"Prayer meeting","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-09T23:30:00.000Z"},{"when":"2026-09-09","time":"6:00p","title":"Youth @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-10T01:00:00.000Z"},{"when":"2026-09-10","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-10T21:30:00.000Z"},{"when":"2026-09-13","time":"8:00a","title":"Sunday morning prayer","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-13T14:00:00.000Z"},{"when":"2026-09-13","time":"9:00a","title":"Sunday School & Morning Worship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-13T16:30:00.000Z"},{"when":"2026-09-13","time":"6:00p","title":"Business meeting","where":"Check with the church for location","tag":"Monthly","endsAt":"2026-09-14T00:00:00.000Z"},{"when":"2026-09-13","time":"6:00p","title":"Sunday evening discipleship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-14T00:00:00.000Z"},{"when":"2026-09-15","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-15T21:30:00.000Z"},{"when":"2026-09-15","time":"5:00p","title":"WMU","where":"Fellowship Hall","tag":"Monthly","endsAt":"2026-09-16T00:00:00.000Z"},{"when":"2026-09-16","time":"6:00p","title":"Prayer meeting","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-16T23:30:00.000Z"},{"when":"2026-09-16","time":"6:00p","title":"Youth @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-17T01:00:00.000Z"},{"when":"2026-09-17","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-17T21:30:00.000Z"},{"when":"2026-09-20","time":"8:00a","title":"Sunday morning prayer","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-20T14:00:00.000Z"},{"when":"2026-09-20","time":"9:00a","title":"Sunday School & Morning Worship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-20T16:30:00.000Z"},{"when":"2026-09-20","time":"6:00p","title":"Sunday evening discipleship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-21T00:00:00.000Z"},{"when":"2026-09-22","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-22T21:30:00.000Z"},{"when":"2026-09-23","time":"6:00p","title":"Prayer meeting","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-23T23:30:00.000Z"},{"when":"2026-09-23","time":"6:00p","title":"Youth @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-24T01:00:00.000Z"},{"when":"2026-09-24","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-24T21:30:00.000Z"},{"when":"2026-09-27","time":"8:00a","title":"Sunday morning prayer","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-27T14:00:00.000Z"},{"when":"2026-09-27","time":"9:00a","title":"Sunday School & Morning Worship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-27T16:30:00.000Z"},{"when":"2026-09-27","time":"6:00p","title":"Sunday evening discipleship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-28T00:00:00.000Z"},{"when":"2026-09-29","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-29T21:30:00.000Z"},{"when":"2026-09-30","time":"6:00p","title":"Prayer meeting","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-09-30T23:30:00.000Z"},{"when":"2026-09-30","time":"6:00p","title":"Youth @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-01T01:00:00.000Z"},{"when":"2026-10-01","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-01T21:30:00.000Z"},{"when":"2026-10-04","time":"8:00a","title":"Sunday morning prayer","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-04T14:00:00.000Z"},{"when":"2026-10-04","time":"9:00a","title":"Sunday School & Morning Worship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-04T16:30:00.000Z"},{"when":"2026-10-04","time":"6:00p","title":"Sunday evening discipleship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-05T00:00:00.000Z"},{"when":"2026-10-06","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-06T21:30:00.000Z"},{"when":"2026-10-07","time":"6:00p","title":"Prayer meeting","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-07T23:30:00.000Z"},{"when":"2026-10-07","time":"6:00p","title":"Youth @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-08T01:00:00.000Z"},{"when":"2026-10-08","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-08T21:30:00.000Z"},{"when":"2026-10-11","time":"8:00a","title":"Sunday morning prayer","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-11T14:00:00.000Z"},{"when":"2026-10-11","time":"9:00a","title":"Sunday School & Morning Worship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-11T16:30:00.000Z"},{"when":"2026-10-11","time":"6:00p","title":"Business meeting","where":"Check with the church for location","tag":"Monthly","endsAt":"2026-10-12T00:00:00.000Z"},{"when":"2026-10-11","time":"6:00p","title":"Sunday evening discipleship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-12T00:00:00.000Z"},{"when":"2026-10-13","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-13T21:30:00.000Z"},{"when":"2026-10-14","time":"6:00p","title":"Prayer meeting","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-14T23:30:00.000Z"},{"when":"2026-10-14","time":"6:00p","title":"Youth @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-15T01:00:00.000Z"},{"when":"2026-10-15","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-15T21:30:00.000Z"},{"when":"2026-10-18","time":"8:00a","title":"Sunday morning prayer","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-18T14:00:00.000Z"},{"when":"2026-10-18","time":"9:00a","title":"Sunday School & Morning Worship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-18T16:30:00.000Z"},{"when":"2026-10-18","time":"6:00p","title":"Sunday evening discipleship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-19T00:00:00.000Z"},{"when":"2026-10-20","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-20T21:30:00.000Z"},{"when":"2026-10-20","time":"5:00p","title":"WMU","where":"Fellowship Hall","tag":"Monthly","endsAt":"2026-10-21T00:00:00.000Z"},{"when":"2026-10-21","time":"6:00p","title":"Prayer meeting","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-21T23:30:00.000Z"},{"when":"2026-10-21","time":"6:00p","title":"Youth @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-22T01:00:00.000Z"},{"when":"2026-10-22","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-22T21:30:00.000Z"},{"when":"2026-10-25","time":"8:00a","title":"Sunday morning prayer","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-25T14:00:00.000Z"},{"when":"2026-10-25","time":"9:00a","title":"Sunday School & Morning Worship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-25T16:30:00.000Z"},{"when":"2026-10-25","time":"6:00p","title":"Sunday evening discipleship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-26T00:00:00.000Z"},{"when":"2026-10-27","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-27T21:30:00.000Z"},{"when":"2026-10-28","time":"6:00p","title":"Prayer meeting","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-28T23:30:00.000Z"},{"when":"2026-10-28","time":"6:00p","title":"Youth @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-29T01:00:00.000Z"},{"when":"2026-10-29","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-10-29T21:30:00.000Z"},{"when":"2026-11-01","time":"8:00a","title":"Sunday morning prayer","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-01T15:00:00.000Z"},{"when":"2026-11-01","time":"9:00a","title":"Sunday School & Morning Worship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-01T17:30:00.000Z"},{"when":"2026-11-01","time":"6:00p","title":"Sunday evening discipleship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-02T01:00:00.000Z"},{"when":"2026-11-03","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-03T22:30:00.000Z"},{"when":"2026-11-04","time":"6:00p","title":"Prayer meeting","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-05T00:30:00.000Z"},{"when":"2026-11-04","time":"6:00p","title":"Youth @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-05T02:00:00.000Z"},{"when":"2026-11-05","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-05T22:30:00.000Z"},{"when":"2026-11-08","time":"8:00a","title":"Sunday morning prayer","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-08T15:00:00.000Z"},{"when":"2026-11-08","time":"9:00a","title":"Sunday School & Morning Worship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-08T17:30:00.000Z"},{"when":"2026-11-08","time":"6:00p","title":"Business meeting","where":"Check with the church for location","tag":"Monthly","endsAt":"2026-11-09T01:00:00.000Z"},{"when":"2026-11-08","time":"6:00p","title":"Sunday evening discipleship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-09T01:00:00.000Z"},{"when":"2026-11-10","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-10T22:30:00.000Z"},{"when":"2026-11-11","time":"6:00p","title":"Prayer meeting","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-12T00:30:00.000Z"},{"when":"2026-11-11","time":"6:00p","title":"Youth @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-12T02:00:00.000Z"},{"when":"2026-11-12","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-12T22:30:00.000Z"},{"when":"2026-11-15","time":"8:00a","title":"Sunday morning prayer","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-15T15:00:00.000Z"},{"when":"2026-11-15","time":"9:00a","title":"Sunday School & Morning Worship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-15T17:30:00.000Z"},{"when":"2026-11-15","time":"6:00p","title":"Sunday evening discipleship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-16T01:00:00.000Z"},{"when":"2026-11-17","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-17T22:30:00.000Z"},{"when":"2026-11-17","time":"5:00p","title":"WMU","where":"Fellowship Hall","tag":"Monthly","endsAt":"2026-11-18T01:00:00.000Z"},{"when":"2026-11-18","time":"6:00p","title":"Prayer meeting","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-19T00:30:00.000Z"},{"when":"2026-11-18","time":"6:00p","title":"Youth Friendsgiving potluck","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-19T02:00:00.000Z"},{"when":"2026-11-19","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-19T22:30:00.000Z"},{"when":"2026-11-22","time":"All day","title":"Youth YEC","where":"Check with the church for location","tag":"Special","allDay":true,"endsAt":"2026-11-24"},{"when":"2026-11-22","time":"8:00a","title":"Sunday morning prayer","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-22T15:00:00.000Z"},{"when":"2026-11-22","time":"9:00a","title":"Sunday School & Morning Worship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-22T17:30:00.000Z"},{"when":"2026-11-22","time":"6:00p","title":"Sunday evening discipleship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-23T01:00:00.000Z"},{"when":"2026-11-24","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-24T22:30:00.000Z"},{"when":"2026-11-25","time":"6:00p","title":"Prayer meeting","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-26T00:30:00.000Z"},{"when":"2026-11-26","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-26T22:30:00.000Z"},{"when":"2026-11-29","time":"8:00a","title":"Sunday morning prayer","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-29T15:00:00.000Z"},{"when":"2026-11-29","time":"9:00a","title":"Sunday School & Morning Worship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-29T17:30:00.000Z"},{"when":"2026-11-29","time":"6:00p","title":"Sunday evening discipleship","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-11-30T01:00:00.000Z"},{"when":"2026-12-01","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-12-01T22:30:00.000Z"},{"when":"2026-12-02","time":"6:00p","title":"Prayer meeting","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-12-03T00:30:00.000Z"},{"when":"2026-12-02","time":"6:00p","title":"Youth @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-12-03T02:00:00.000Z"},{"when":"2026-12-03","time":"3:45p","title":"Yoga @ the Creek","where":"Check with the church for location","tag":"Weekly","endsAt":"2026-12-03T22:30:00.000Z"}]};
  var UNKNOWN_TIME = 'Time to be confirmed';

  function churchToday(now) {
    var fields = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now || new Date()).forEach(function (part) { fields[part.type] = part.value; });
    return fields.year + '-' + fields.month + '-' + fields.day;
  }
  function churchMinutes(now) {
    var fields = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
      .formatToParts(now || new Date()).forEach(function (part) { fields[part.type] = part.value; });
    return +fields.hour * 60 + +fields.minute;
  }
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || +value.slice(0, 4) < 1) return false;
    var date = new Date(value + 'T12:00:00Z');
    return !isNaN(date) && date.toISOString().slice(0, 10) === value;
  }
  function startMinutes(value) {
    if (typeof value !== 'string') return null;
    var match = /^(1[0-2]|[1-9])(?::([0-5]\d))?\s*([ap])m?$/i.exec(value.trim());
    return match ? ((+match[1] % 12) + (match[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + +(match[2] || 0) : null;
  }
  function clock(minutes) { return (Math.floor(minutes / 60) % 12 || 12) + ':' + String(minutes % 60).padStart(2, '0') + (minutes >= 720 ? 'p' : 'a'); }
  function sheetTime(value) {
    value = String(value || '').trim();
    if (!value) return UNKNOWN_TIME;
    var minutes = startMinutes(value);
    if (minutes !== null) return clock(minutes);
    var match = /^(1[0-2]|0?[1-9]):([0-5]\d):([0-5]\d)\s*([ap])m$/i.exec(value);
    if (match) return clock(((+match[1] % 12) + (match[4].toLowerCase() === 'p' ? 12 : 0)) * 60 + +match[2]);
    match = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value);
    return match ? clock(+match[1] * 60 + +match[2]) : null;
  }
  function sheetDate(value) {
    value = String(value || '').trim();
    var match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
    if (match) value = match[3] + '-' + match[1].padStart(2, '0') + '-' + match[2].padStart(2, '0');
    return validDate(value) ? value : null;
  }
  function text(value, max) { return typeof value === 'string' ? value.trim().slice(0, max || 240) : ''; }
  function normalizeEvent(event) {
    if (!event || typeof event !== 'object' || !validDate(event.when)) return null;
    if (['Weekly', 'Monthly', 'Special'].indexOf(event.tag) < 0) return null;
    var title = text(event.title, 160), where = text(event.where, 240), time = text(event.time, 50);
    var allDay = event.allDay === true;
    if (!title || !where || (startMinutes(time) === null && time !== UNKNOWN_TIME && !(allDay && time === 'All day'))) return null;
    var clean = { when: event.when, time: time, title: title, where: where, tag: event.tag };
    if (allDay) clean.allDay = true;
    if (event.endsAt !== undefined) {
      if (allDay) {
        if (!validDate(event.endsAt) || event.endsAt <= event.when) return null;
      } else if (typeof event.endsAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(event.endsAt) || isNaN(Date.parse(event.endsAt)) || churchToday(new Date(event.endsAt)) < event.when) return null;
      clean.endsAt = event.endsAt;
    }
    if (text(event.details, 2000)) clean.details = text(event.details, 2000);
    return clean;
  }
  function upcomingEvents(events, today) {
    return (Array.isArray(events) ? events : []).map(normalizeEvent).filter(function (event) { return event && (event.when >= today || (event.endsAt && (event.allDay ? event.endsAt > today : churchToday(new Date(event.endsAt)) >= today))); })
      .sort(function (a, b) { return a.when.localeCompare(b.when) || (a.allDay ? -1 : (startMinutes(a.time) ?? 1440)) - (b.allDay ? -1 : (startMinutes(b.time) ?? 1440)); });
  }
  function isUpcoming(event, today, minutes) {
    if (event.endsAt) {
      if (event.allDay) return event.endsAt > today;
      var end = new Date(event.endsAt), endDay = churchToday(end);
      return endDay > today || (endDay === today && churchMinutes(end) > minutes);
    }
    var start = startMinutes(event.time);
    return event.when > today || (event.when === today && (event.allDay || start === null || start >= minutes));
  }
  function eventTimeLabel(event) {
    if (!event.endsAt) return event.time;
    if (!event.allDay) {
      var end = new Date(event.endsAt), endTime = clock(churchMinutes(end));
      return churchToday(end) === event.when ? event.time + '–' + endTime : event.time + ' · through ' +
        end.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'America/Chicago'}) + ' ' + endTime;
    }
    var last = new Date(event.endsAt + 'T12:00:00Z'); last.setUTCDate(last.getUTCDate() - 1);
    if (last.toISOString().slice(0, 10) === event.when) return 'All day';
    return 'All day · through ' + last.toLocaleDateString('en-US', {month:'short',day:'numeric',timeZone:'UTC'});
  }
  function key(event) { return event.when + '|' + event.title.trim().replace(/\s+/g, ' ').toLowerCase(); }

  // RFC-style quoted fields, including commas, CRLF, escaped quotes, and newlines.
  function parseCSV(source) {
    if (typeof source !== 'string' || source.length > 1000000) throw new Error('Invalid calendar CSV');
    source = source.replace(/^\uFEFF/, '');
    var rows = [], row = [], field = '', quoted = false, closed = false;
    for (var i = 0; i <= source.length; i++) {
      var ch = source[i];
      if (quoted) {
        if (ch === undefined) throw new Error('Unclosed calendar field');
        if (ch === '"' && source[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') { quoted = false; closed = true; }
        else field += ch;
      } else if (ch === ',' || ch === '\n' || ch === '\r' || ch === undefined) {
        row.push(field); field = ''; closed = false;
        if (ch !== ',') {
          if (row.some(function (v) { return v.trim(); })) rows.push(row);
          row = [];
          if (ch === '\r' && source[i + 1] === '\n') i++;
        }
      } else if (ch === '"') {
        if (field || closed) throw new Error('Invalid calendar quoting');
        quoted = true;
      } else {
        if (closed && !/\s/.test(ch)) throw new Error('Unexpected calendar field suffix');
        if (!closed) field += ch;
      }
    }
    return rows;
  }
  function communityRows(source) {
    var rows = parseCSV(source), headers = rows.shift() || [];
    headers = headers.map(function (v) { return v.trim().toLowerCase(); });
    if (!['title', 'date', 'start', 'location', 'type'].every(function (v) { return headers.includes(v); })) throw new Error('Calendar headers unavailable');
    function column(row, name) { return row[headers.indexOf(name)] || ''; }
    return rows.map(function (row) {
      var action = column(row, 'type').trim().toLowerCase();
      if (!['add a new event', 'change an existing event', 'cancel an event'].includes(action)) return null;
      var when = sheetDate(column(row, 'date')), title = text(column(row, 'title'), 160);
      if (!when || !title) return null;
      if (action === 'cancel an event') return { action: 'cancel', event: { when: when, title: title } };
      var event = normalizeEvent({ when: when, title: title, time: sheetTime(column(row, 'start')), where: text(column(row, 'location')) || 'Location to be confirmed', details: column(row, 'details'), tag: 'Special' });
      return event ? { action: 'upsert', event: event } : null;
    }).filter(Boolean);
  }
  function expandFeed(data, today, horizon) {
    if (!data || (!Array.isArray(data.events) && !Array.isArray(data.recurring))) throw new Error('Calendar feed invalid');
    if (data.source === 'icloud') return upcomingEvents(data.events, today);
    var days = Math.max(1, Math.min(horizon || 42, 93)), map = new Map();
    (data.recurring || []).forEach(function (rule) {
      if (!rule || !Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) return;
      if (rule.ordinal !== undefined && (!Number.isInteger(rule.ordinal) || rule.ordinal < 1 || rule.ordinal > 5)) return;
      for (var i = 0; i < days; i++) {
        var day = new Date(today + 'T12:00:00Z'); day.setUTCDate(day.getUTCDate() + i);
        if (day.getUTCDay() !== rule.weekday || (rule.ordinal && Math.ceil(day.getUTCDate() / 7) !== rule.ordinal)) continue;
        var event = normalizeEvent(Object.assign({}, rule, { when: day.toISOString().slice(0, 10) }));
        if (event) map.set(key(event), event);
      }
    });
    upcomingEvents(data.events, today).forEach(function (event) { map.set(key(event), event); });
    return upcomingEvents(Array.from(map.values()), today);
  }
  function mergeCommunity(base, changes, today) {
    var map = new Map();
    base.forEach(function (event) { map.set(key(event), event); });
    changes.forEach(function (change) {
      if (change.action === 'cancel') map.delete(key(change.event));
      else map.set(key(change.event), change.event);
    });
    return upcomingEvents(Array.from(map.values()), today);
  }
  async function request(fetcher, url, format, timeoutMs) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer;
    try {
      return await Promise.race([
        Promise.resolve().then(async function () {
          var response = await fetcher(url, { cache: 'no-cache', signal: controller ? controller.signal : undefined });
          if (!response.ok) throw new Error('Calendar source unavailable');
          var value = await response[format]();
          return { value: value, source: response.headers && response.headers.get('X-Creek-Cache') === 'offline' ? 'cache' : 'network' };
        }),
        new Promise(function (_, reject) { timer = setTimeout(function () { if (controller) controller.abort(); reject(new Error('Calendar request timed out')); }, timeoutMs || 8000); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async function load(options) {
    options = options || {};
    if (options.calendarUrl || (options.fallback || DEFAULT_FEED).source === 'icloud') return loadIcloud(options);
    var today = churchToday(options.now), fetcher = options.fetcher || fetch;
    var base = expandFeed(options.fallback || DEFAULT_FEED, today);
    var sources = { weekly: 'fallback', community: 'unavailable' };
    var responses = await Promise.allSettled([
      request(fetcher, options.jsonUrl || './events.json', 'json', options.timeoutMs),
      request(fetcher, options.csvUrl || CSV_URL, 'text', options.timeoutMs)
    ]);
    if (responses[0].status === 'fulfilled') {
      try { base = expandFeed(responses[0].value.value, today); sources.weekly = responses[0].value.source; } catch (_) { /* Retain the verified schedule. */ }
    }
    if (responses[1].status === 'fulfilled') {
      try { base = mergeCommunity(base, communityRows(responses[1].value.value), today); sources.community = responses[1].value.source; } catch (_) { /* Never render an error page or unreviewed fields. */ }
    }
    var minutes = churchMinutes(options.now);
    base = base.filter(function (event) { return isUpcoming(event, today, minutes); });
    return { events: base, sources: sources };
  }
  function validSnapshot(data) {
    return data && data.source === 'icloud' && Array.isArray(data.events) && data.events.length <= 5000 && data.events.every(normalizeEvent) && validDate(data.valid_until) &&
      typeof data.synced_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(data.synced_at) &&
      !isNaN(Date.parse(data.synced_at)) && data.valid_until >= churchToday(new Date(data.synced_at));
  }
  async function loadIcloud(options) {
    var now = options.now || new Date(), today = churchToday(now), minutes = churchMinutes(now);
    var fallback = options.fallback || DEFAULT_FEED, chosen = validSnapshot(fallback) ? fallback : null;
    var transport = 'fallback', live = false, fetcher = options.fetcher || fetch;
    var urls = options.calendarUrl ? [options.calendarUrl, options.jsonUrl || './events.json'] : [options.jsonUrl || './events.json'];
    var responses = await Promise.allSettled(urls.map(function (url) { return request(fetcher, url, 'json', options.timeoutMs); }));
    for (var i = 0; i < responses.length; i++) {
      var response = responses[i];
      if (response.status === 'fulfilled' && validSnapshot(response.value.value) && (!chosen || Date.parse(response.value.value.synced_at) >= Date.parse(chosen.synced_at))) {
        if (chosen && live && Date.parse(response.value.value.synced_at) === Date.parse(chosen.synced_at)) continue;
        chosen = response.value.value; transport = response.value.source; live = !!options.calendarUrl && i === 0 && transport === 'network';
      }
    }
    var events = chosen ? upcomingEvents(chosen.events, today).filter(function (event) { return isUpcoming(event, today, minutes); }) : [];
    return { source:'icloud', events:events, sources:{weekly:transport,community:'not-used'},
      updatedAt:chosen ? chosen.synced_at : null, validUntil:chosen ? chosen.valid_until : null,
      expired:!chosen || chosen.valid_until < today,
      stale:!chosen || chosen.valid_until < today || now.getTime() - Date.parse(chosen.synced_at) > 86400000,
      live:live };
  }
  function statusText(result) {
    if (result.source === 'icloud') {
      if (!result.updatedAt) return 'The church calendar is unavailable. Please check with the church for updates.';
      var date = new Date(result.updatedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'America/Chicago'});
      if (result.expired) return 'The saved church calendar has expired. Please check with the church for current events.';
      return (result.stale || result.sources.weekly === 'cache' ? 'Saved church calendar from ' : 'Church calendar updated ') + date + '. All times Central.' +
        (result.stale || result.sources.weekly === 'cache' ? ' Recent changes may be missing.' : '');
    }
    return result.sources.community === 'unavailable' ? 'Regular gatherings are shown. Community updates are temporarily unavailable.' :
      result.sources.community === 'cache' ? 'Showing saved calendar updates. Recent changes need an internet connection.' :
      'All times Central. Approved updates may take a few minutes to appear.';
  }
  return { CSV_URL: CSV_URL, FORM_URL: FORM_URL, DEFAULT_FEED: DEFAULT_FEED, churchToday: churchToday, churchMinutes: churchMinutes, validDate: validDate, startMinutes: startMinutes, upcomingEvents: upcomingEvents, isUpcoming:isUpcoming, eventTimeLabel:eventTimeLabel, statusText:statusText, validSnapshot:validSnapshot, parseCSV: parseCSV, communityRows: communityRows, expandFeed: expandFeed, mergeCommunity: mergeCommunity, load: load };
}));
