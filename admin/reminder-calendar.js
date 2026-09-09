/* A generic calendar check-in. No private records enter the downloaded file. */
(function (root) {
  'use strict';
  function localDate(date) { return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); }
  function nextMonday(now) {
    var date = new Date(now); date.setHours(9, 0, 0, 0); date.setDate(date.getDate() + (8 - date.getDay()) % 7);
    if (date <= now) date.setDate(date.getDate() + 7);
    return localDate(date);
  }
  function startDate(date, time, now) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Choose a valid date and time.');
    var result = new Date(date + 'T' + time + ':00');
    if (!Number.isFinite(result.getTime()) || localDate(result) !== date || result.getHours() !== Number(time.slice(0, 2)) || result.getMinutes() !== Number(time.slice(3))) throw new Error('Choose a valid local date and time.');
    if (result <= now) throw new Error('Choose a first check-in that is still ahead of you.');
    return result;
  }
  function build(date, time, now) {
    now = now || new Date();
    var start = startDate(date, time, now), day = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][start.getDay()];
    // Floating local time follows the calendar's local-time interpretation (RFC 5545).
    // It is deliberately not a fixed UTC offset that could shift after daylight saving.
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bluff Creek//Personal Check-in//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
      'UID:creek-office-weekly-leader-review@bluffcreek.local',
      'DTSTAMP:' + now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'),
      'DTSTART:' + date.replace(/-/g, '') + 'T' + time.replace(':', '') + '00',
      'DURATION:PT15M', 'RRULE:FREQ=WEEKLY;BYDAY=' + day,
      'SUMMARY:Review my leadership follow-ups',
      'DESCRIPTION:Open Creek Office > My follow-ups. Pray for your leaders\\n',
      ' and choose who to call this week. Keep contact notes in Creek Office.',
      'CLASS:PRIVATE', 'TRANSP:TRANSPARENT', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M',
      'DESCRIPTION:Time to review your leadership follow-ups.', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'];
    return lines.join('\r\n') + '\r\n';
  }
  function create(options) {
    var button = options.button, doc = button.ownerDocument, win = doc.defaultView, dialog = null, url = null;
    function revoke() { if (url) { win.URL.revokeObjectURL(url); url = null; } }
    function clear() { revoke(); if (dialog) { if (dialog.open) dialog.close(); dialog.remove(); dialog = null; } }
    function open() {
      if (!options.allowed()) return;
      clear(); dialog = doc.createElement('dialog'); dialog.className = 'reminder-calendar-dialog'; dialog.setAttribute('aria-labelledby', 'reminder-calendar-title');
      dialog.innerHTML = '<form><header><div><p class="eyebrow">A little space each week</p><h2 id="reminder-calendar-title">Make reaching out a rhythm.</h2></div></header><div class="reminder-calendar-fields"><p>Download a 15-minute weekly check-in with a reminder 10 minutes before. Open the file in your personal calendar and confirm its time and alert.</p><div class="form-grid"><label>First check-in<input type="date" name="date" required></label><label>Time in your calendar<input type="time" name="time" value="09:00" required></label></div><p class="reminder-preview" data-calendar-preview></p><p>This uses local calendar time. Your calendar controls notifications. Importing the file is required; downloading alone does not activate a reminder.</p><details><summary>What goes into the calendar?</summary><p>Only “Review my leadership follow-ups” and a prompt to open Creek Office. Names, contact notes and your due list stay in the office. This is a weekly check-in, not a live sync of each leader’s deadline.</p><p>After importing, change or remove the recurring event in your calendar. Check for an existing copy before importing again.</p><a href="https://support.apple.com/guide/calendar/import-or-export-calendars-icl1023/mac" target="_blank" rel="noopener">How to import into Apple Calendar ↗</a></details><p role="alert" data-calendar-error></p><div data-calendar-download></div></div><footer><button class="quiet" type="button" data-calendar-close>Close</button><button type="submit">Prepare calendar file</button></footer></form>';
      var form = dialog.querySelector('form'), result = dialog.querySelector('[data-calendar-download]'), error = dialog.querySelector('[data-calendar-error]');
      form.elements.date.min = localDate(new Date()); form.elements.date.value = nextMonday(new Date());
      function preview() {
        revoke(); result.replaceChildren(); error.textContent = '';
        var label = dialog.querySelector('[data-calendar-preview]');
        try { var start = startDate(form.elements.date.value, form.elements.time.value, new Date()); label.textContent = 'Every ' + start.toLocaleDateString('en-US', { weekday: 'long' }) + ' at ' + start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ' · 15 minutes'; }
        catch (_) { label.textContent = 'Choose when to begin your weekly check-in.'; }
      }
      form.elements.date.oninput = preview; form.elements.time.oninput = preview; preview();
      form.onsubmit = function (event) {
        event.preventDefault(); if (!options.allowed() || !form.reportValidity()) return;
        revoke(); result.replaceChildren(); error.textContent = '';
        try {
          var content = build(form.elements.date.value, form.elements.time.value);
          url = win.URL.createObjectURL(new win.Blob([content], { type: 'text/calendar;charset=utf-8' }));
          var link = doc.createElement('a'); link.href = url; link.download = 'creek-office-weekly-check-in.ics'; link.className = 'calendar-download'; link.textContent = 'Download weekly check-in (.ics)';
          var help = doc.createElement('p'); help.textContent = 'Next: open this file in your calendar, choose your personal calendar, and confirm the weekly event and alert.';
          result.append(link, help); link.focus();
        } catch (failure) { error.textContent = failure.message || 'The calendar file could not be prepared.'; }
      };
      dialog.querySelector('[data-calendar-close]').onclick = clear;
      dialog.addEventListener('cancel', function (event) { event.preventDefault(); clear(); });
      doc.body.appendChild(dialog); dialog.showModal();
    }
    button.onclick = open;
    return { clear: clear, open: open };
  }
  root.CreekReminderCalendar = { create: create, build: build, nextMonday: nextMonday };
}(typeof window !== 'undefined' ? window : globalThis));
