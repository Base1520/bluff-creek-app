/* Personal listening notes stay in this browser; nothing is submitted. */
(function () {
  'use strict';
  var guide = document.getElementById('listening-guide');
  if (!guide) return;
  var key = 'creek-listening-habakkuk-1-5-11-2026-09-27-v1';
  var fields = Array.from(guide.querySelectorAll('[data-guide-field]'));
  var status = document.getElementById('guide-save-status');
  var timer;
  function message(text) { if (status.textContent !== text) status.textContent = text; }
  function unavailable() { message('Saving is unavailable in this browser. Keep this page open to keep your answers, or use the printable guide.'); }
  try {
    var stored = JSON.parse(localStorage.getItem(key) || '{}');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      fields.forEach(function (field) {
        var value = stored[field.dataset.guideField];
        if (typeof value === 'string') field.value = value.slice(0, field.maxLength);
      });
    }
    var probe = key + '-storage-check';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    message('Your answers save on this device and browser only. They are not sent to the church or synced to other devices.');
  } catch (_) { unavailable(); }
  function save() {
    clearTimeout(timer);
    timer = null;
    var values = {};
    fields.forEach(function (field) { values[field.dataset.guideField] = field.value.slice(0, field.maxLength); });
    try {
      localStorage.setItem(key, JSON.stringify(values));
      message('Saved on this device and browser only. Your answers are not sent to the church.');
    } catch (_) { unavailable(); }
  }
  fields.forEach(function (field) { field.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(save, 250); }); });
  window.addEventListener('pagehide', function () { if (timer) save(); });
  document.getElementById('guide-clear').addEventListener('click', function () {
    if (!window.confirm('Clear your answers and personal notes for this listening guide on this device?')) return;
    clearTimeout(timer); timer = null;
    try { localStorage.removeItem(key); }
    catch (_) { message('Unable to clear the saved copy in this browser. Your current answers are still here.'); return; }
    fields.forEach(function (field) { field.value = ''; });
    message('Your answers and personal notes for this guide have been cleared on this device.');
    fields[0].focus();
  });
}());
