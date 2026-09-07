/* Shared public calendar. Keep this file identical in the website and member app.
   Only the reviewed Approved sheet is read; private submission/admin columns are ignored. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CreekCalendar = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSYntD_RzVFtEbbz8r-IP-tQ8YvHYnrpgsCi-xRdnmQ6bEMMQd9Mryrn7UYZpyMBklrszUMrDr2fda7/pub?gid=0&single=true&output=csv';
  var FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSfcjsMhQHqRClov1oXBgkhCP_tcvWKtQyPltvYVLyVzSkj1Kg/viewform';
  var DEFAULT_FEED = {"updated":"2026-09-06","events":[{"when":"2026-09-06","time":"9:00a","title":"Sunday School","where":"Fellowship Building","tag":"Weekly"},{"when":"2026-09-06","time":"10:15a","title":"Sunday Worship","where":"Sanctuary","tag":"Weekly"},{"when":"2026-09-06","time":"5:30p","title":"Youth discipleship","where":"Fellowship Building","tag":"Weekly"},{"when":"2026-09-06","time":"6:00p","title":"Evening service","where":"Sanctuary","tag":"Weekly"},{"when":"2026-09-07","time":"6:30p","title":"Women’s Bible study","where":"Contact church office for location","tag":"Weekly"},{"when":"2026-09-08","time":"5:00p","title":"Yoga @ the Creek","where":"Fellowship Building","tag":"Weekly"},{"when":"2026-09-09","time":"6:00p","title":"Prayer meeting","where":"Sanctuary","tag":"Weekly"},{"when":"2026-09-09","time":"6:00p","title":"Youth @ the Creek — MDWK","where":"Fellowship Building","tag":"Weekly"},{"when":"2026-09-10","time":"5:00p","title":"Yoga @ the Creek","where":"Fellowship Building","tag":"Weekly"},{"when":"2026-09-13","time":"9:00a","title":"Sunday School","where":"Fellowship Building","tag":"Weekly"},{"when":"2026-09-13","time":"10:15a","title":"Sunday Worship","where":"Sanctuary","tag":"Weekly"},{"when":"2026-09-13","time":"5:30p","title":"Youth discipleship","where":"Fellowship Building","tag":"Weekly"},{"when":"2026-09-13","time":"6:00p","title":"Evening service","where":"Sanctuary","tag":"Weekly"},{"when":"2026-09-14","time":"6:30p","title":"Women’s Bible study","where":"Contact church office for location","tag":"Weekly"},{"when":"2026-09-15","time":"5:00p","title":"Yoga @ the Creek","where":"Fellowship Building","tag":"Weekly"},{"when":"2026-09-15","time":"6:00p","title":"WMU","where":"Fellowship Hall","tag":"Monthly"},{"when":"2026-09-16","time":"6:00p","title":"Prayer meeting","where":"Sanctuary","tag":"Weekly"},{"when":"2026-09-16","time":"6:00p","title":"Youth @ the Creek — MDWK","where":"Fellowship Building","tag":"Weekly"},{"when":"2026-09-17","time":"5:00p","title":"Yoga @ the Creek","where":"Fellowship Building","tag":"Weekly"}],"recurring":[{"time":"9:00a","title":"Sunday School","where":"Fellowship Building","tag":"Weekly","weekday":0},{"time":"10:15a","title":"Sunday Worship","where":"Sanctuary","tag":"Weekly","weekday":0},{"time":"5:30p","title":"Youth discipleship","where":"Fellowship Building","tag":"Weekly","weekday":0},{"time":"6:00p","title":"Evening service","where":"Sanctuary","tag":"Weekly","weekday":0},{"time":"6:30p","title":"Women’s Bible study","where":"Contact church office for location","tag":"Weekly","weekday":1},{"time":"5:00p","title":"Yoga @ the Creek","where":"Fellowship Building","tag":"Weekly","weekday":2},{"time":"6:00p","title":"Prayer meeting","where":"Sanctuary","tag":"Weekly","weekday":3},{"time":"6:00p","title":"Youth @ the Creek — MDWK","where":"Fellowship Building","tag":"Weekly","weekday":3},{"time":"5:00p","title":"Yoga @ the Creek","where":"Fellowship Building","tag":"Weekly","weekday":4},{"time":"6:00p","title":"WMU","where":"Fellowship Hall","tag":"Monthly","weekday":2,"ordinal":3}]};
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
    if (!title || !where || (startMinutes(time) === null && time !== UNKNOWN_TIME)) return null;
    var clean = { when: event.when, time: time, title: title, where: where, tag: event.tag };
    if (text(event.details, 2000)) clean.details = text(event.details, 2000);
    return clean;
  }
  function upcomingEvents(events, today) {
    return (Array.isArray(events) ? events : []).map(normalizeEvent).filter(function (event) { return event && event.when >= today; })
      .sort(function (a, b) { return a.when.localeCompare(b.when) || (startMinutes(a.time) ?? 1440) - (startMinutes(b.time) ?? 1440); });
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
    base = base.filter(function (event) { var start = startMinutes(event.time); return event.when > today || start === null || start >= minutes; });
    return { events: base, sources: sources };
  }
  return { CSV_URL: CSV_URL, FORM_URL: FORM_URL, DEFAULT_FEED: DEFAULT_FEED, churchToday: churchToday, churchMinutes: churchMinutes, validDate: validDate, startMinutes: startMinutes, upcomingEvents: upcomingEvents, parseCSV: parseCSV, communityRows: communityRows, expandFeed: expandFeed, mergeCommunity: mergeCommunity, load: load };
}));
