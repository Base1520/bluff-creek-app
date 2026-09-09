const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
  'Access-Control-Max-Age': '600',
  'X-Content-Type-Options': 'nosniff',
};
const UNAVAILABLE = { error: 'calendar_unavailable', message: 'The church calendar is temporarily unavailable. Please try again shortly.' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** Only operator-configured published Apple calendar endpoints are accepted. */
export function validateSourceURL(value) {
  if (typeof value !== 'string' || value.length > 4096 || /\s/.test(value) || !/^(?:https|webcal):\/\//i.test(value)) return null;
  try {
    const url = new URL(value.replace(/^webcal:/i, 'https:'));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
    if (!/^(?:p\d{1,4}-)?(?:calendars|caldav)\.icloud\.com$/.test(url.hostname)) return null;
    if (!/^\/published\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
}
function text(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid public calendar');
  return value;
}
function isDate(value) {
  return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
function isUTC(value) { return typeof value === 'string' && UTC.test(value) && !Number.isNaN(Date.parse(value)); }

// A second field allowlist prevents a future converter diagnostic or raw field
// from accidentally becoming part of the anonymous JSON response.
function publicFeed(feed, fetchedAt) {
  if (!feed || feed.source !== 'icloud' || !Array.isArray(feed.recurring) || feed.recurring.length || !Array.isArray(feed.events) || feed.events.length > 5000) throw new Error('Invalid public calendar');
  if (!isDate(feed.updated) || !isUTC(feed.synced_at) || !isDate(feed.valid_until)) throw new Error('Invalid public calendar');
  if (Date.parse(feed.synced_at) !== fetchedAt.getTime() || feed.valid_until < fetchedAt.toISOString().slice(0, 10)) throw new Error('Invalid public calendar');
  const events = feed.events.map(event => {
    if (!event || !isDate(event.when) || !['Weekly', 'Monthly', 'Special'].includes(event.tag)) throw new Error('Invalid public calendar');
    const result = { when: event.when, time: text(event.time, 30), title: text(event.title, 160), where: text(event.where, 160), tag: event.tag };
    if (event.allDay === true) {
      if (event.time !== 'All day' || !isDate(event.endsAt) || event.endsAt <= event.when) throw new Error('Invalid public calendar');
      result.allDay = true; result.endsAt = event.endsAt;
    } else {
      if (!/^(1[0-2]|[1-9])(?::[0-5]\d)?\s*[ap]m?$/i.test(event.time) || (event.endsAt !== undefined && !isUTC(event.endsAt))) throw new Error('Invalid public calendar');
      if (event.endsAt !== undefined) result.endsAt = event.endsAt;
    }
    return result;
  });
  return { source: 'icloud', updated: feed.updated, synced_at: feed.synced_at, valid_until: feed.valid_until, recurring: [], events };
}

function publicICS(value) {
  if (typeof value !== 'string' || !value.startsWith('BEGIN:VCALENDAR\r\n') || !value.trimEnd().endsWith('END:VCALENDAR')) throw new Error('Invalid public calendar');
  const allowed = new Set(['BEGIN', 'END', 'VERSION', 'PRODID', 'CALSCALE', 'METHOD', 'UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY', 'LOCATION', 'CLASS']);
  for (const line of value.replace(/\r\n[ \t]/g, '').split(/\r?\n/)) {
    if (!line) continue;
    const colon = line.indexOf(':');
    const key = line.slice(0, colon).split(';')[0].toUpperCase();
    if (colon < 1 || !allowed.has(key)) throw new Error('Invalid public calendar');
    if ((key === 'BEGIN' || key === 'END') && !['VCALENDAR', 'VEVENT'].includes(line.slice(colon + 1))) throw new Error('Invalid public calendar');
    if (key === 'CLASS' && line.slice(colon + 1) !== 'PUBLIC') throw new Error('Invalid public calendar');
  }
  return value;
}

async function limitedText(response, limit, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); throw new Error('Calendar too large'); }
  if (!response.body) throw new Error('Calendar response missing');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, value = '';
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (signal.aborted) throw new Error('Calendar timed out');
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) { cancel(); throw new Error('Calendar too large'); }
      value += decoder.decode(chunk.value, { stream: true });
    }
    return value + decoder.decode();
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/**
 * Pure Web Request/Response adapter. No environment, DB or Auth access.
 * @param {{sourceURL?: string, convert?: (source: string, options: {now: Date, horizonDays: number}) => any, fetcher?: typeof fetch, now?: () => Date, timeoutMs?: number, maxBytes?: number, cacheMs?: number}} options
 * @returns {(request: Request) => Promise<Response>}
 */
export function createCalendarHandler({ sourceURL, convert, fetcher = fetch, now = () => new Date(), timeoutMs = 8000, maxBytes = 2 * 1024 * 1024, cacheMs = 60000 } = {}) {
  const source = validateSourceURL(sourceURL);
  // Test injection may shorten these limits, but cannot remove the hard bounds.
  const timeout = Math.min(8000, Math.max(1, Number(timeoutMs) || 8000));
  const size = Math.min(2 * 1024 * 1024, Math.max(1, Number(maxBytes) || 2 * 1024 * 1024));
  const ttl = Math.min(60000, Math.max(0, Number(cacheMs) || 0));
  let cached = null, pending = null;

  async function refresh() {
    const controller = new AbortController();
    const started = performance.now();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Calendar timed out')); }, timeout);
    });
    const work = (async () => {
      const response = await fetcher(source, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'text/calendar' } });
      if (!response.ok || response.redirected) { await response.body?.cancel(); throw new Error('Calendar unavailable'); }
      const raw = await limitedText(response, size, controller.signal);
      const fetchedAt = now();
      const result = await convert(raw, { now: fetchedAt, horizonDays: 90 });
      if (controller.signal.aborted || performance.now() - started > timeout) throw new Error('Calendar timed out');
      const feed = publicFeed(result?.feed, fetchedAt), ics = publicICS(result?.ics);
      const snapshot = { json: JSON.stringify(feed), ics, expiresAt: fetchedAt.getTime() + ttl };
      if (new TextEncoder().encode(snapshot.json).length > size || new TextEncoder().encode(ics).length > size) throw new Error('Calendar too large');
      cached = snapshot;
      return snapshot;
    })();
    try { return await Promise.race([work, expired]); }
    finally { clearTimeout(timer); }
  }

  return async function handle(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, OPTIONS' });
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => key !== 'format') || query.getAll('format').length > 1 || (query.has('format') && !['json', 'ics'].includes(query.get('format')))) return json({ error: 'invalid_request' }, 400);
    if (!source || typeof convert !== 'function') return json(UNAVAILABLE, 503, { 'Retry-After': '60' });
    try {
      let snapshot = cached;
      if (!snapshot || now().getTime() >= snapshot.expiresAt) {
        if (!pending) pending = refresh().finally(() => { pending = null; });
        snapshot = await pending;
      }
      const seconds = Math.max(0, Math.floor((snapshot.expiresAt - now().getTime()) / 1000));
      const calendar = query.get('format') === 'ics';
      return new Response(calendar ? snapshot.ics : snapshot.json, { headers: { ...CORS, 'Content-Type': calendar ? 'text/calendar; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': seconds ? 'public, max-age=' + seconds : 'no-store', ...(calendar ? { 'Content-Disposition': 'inline; filename="church-calendar.ics"' } : {}) } });
    } catch {
      // Never log or return the source URL, raw calendar, upstream body or error.
      return json(UNAVAILABLE, 503, { 'Retry-After': '60' });
    }
  };
}
