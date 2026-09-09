/* Email drafts only. No form contents are persisted or posted to a webhook. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CreekForms = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function value(form, name) { return form.elements.namedItem(name).value.trim(); }
  function checked(form, name) { return form.elements.namedItem(name).checked ? 'yes' : 'no'; }
  function draft(form, kind, email) {
    var subject, body;
    if (kind === 'join') {
      subject = 'Connect @ the Creek';
      body = 'A connection request from the Creek app\n\nName: ' + [value(form, 'first'), value(form, 'last')].filter(Boolean).join(' ') +
        '\nEmail: ' + value(form, 'email') + '\nPhone: ' + value(form, 'phone') +
        '\nFirst visit: ' + checked(form, 'guest') + '\nInterested in text updates: ' + checked(form, 'texts') +
        '\nInterested in future church email updates: ' + checked(form, 'the63') + '\nPrayer: ' + value(form, 'prayer');
    } else {
      subject = 'Prayer @ the Creek';
      body = 'A prayer request from the Creek app\n\nFrom: ' + (value(form, 'name') || 'Name not provided') +
        '\nContact: ' + value(form, 'contact') + '\nPlease keep within the pastor and prayer team: ' + checked(form, 'private') +
        '\n\n' + value(form, 'req');
    }
    return 'mailto:' + email + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  function initialize(doc, options) {
    options = options || {};
    var email = options.email || '';
    var navigate = options.navigate || function (url) { doc.defaultView.location.href = url; };
    ['join', 'prayer'].forEach(function (kind) {
      var form = doc.getElementById(kind === 'join' ? 'joinForm' : 'prayForm');
      var status = doc.getElementById(kind === 'join' ? 'joinStatus' : 'prayStatus');
      if (!form || !status || form.dataset.draftReady) return;
      form.dataset.draftReady = 'true';
      form.hidden = false;
      Array.from(form.elements).forEach(function (field) {
        if (field.setCustomValidity) field.addEventListener('input', function () { field.setCustomValidity(''); });
      });
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        Array.from(form.elements).forEach(function (field) {
          if (field.required && field.setCustomValidity) field.setCustomValidity(field.value.trim() ? '' : 'Please complete this field.');
        });
        if (!form.reportValidity()) return;
        status.hidden = false;
        if (!email) {
          status.textContent = 'Email is unavailable here. Use the contact page to reach the church. Your entries remain on this page.';
          return;
        }
        status.textContent = 'If your email app opened, review the draft and send it there. Nothing is sent by this page. Your entries remain here until you leave.';
        try { navigate(draft(form, kind, email)); }
        catch (_) { status.textContent = 'Your email app could not be opened. Use the email link below; your entries remain here until you leave.'; }
      });
    });

    // Offer explicit removal of legacy local drafts without reading their contents.
    var legacy = doc.getElementById('legacyDrafts');
    var clear = doc.getElementById('clearLegacyDrafts');
    var legacyStatus = doc.getElementById('legacyDraftStatus');
    var storage;
    try { storage = options.storage || doc.defaultView.localStorage; } catch (_) { return; }
    var keys = ['creek_join', 'creek_prayer'];
    if (!legacy || !clear || !legacyStatus || !storage || clear.dataset.draftReady) return;
    if (!keys.some(function (key) { return Object.prototype.hasOwnProperty.call(storage, key); })) return;
    legacy.hidden = false;
    clear.dataset.draftReady = 'true';
    clear.addEventListener('click', function () {
      try {
        keys.forEach(function (key) { storage.removeItem(key); });
        legacyStatus.textContent = 'Old form drafts cleared from this device. Your email is unchanged.';
        clear.disabled = true;
      } catch (_) {
        legacyStatus.textContent = 'The browser could not clear the old drafts. You can remove this app’s site data in your browser settings.';
      }
    });
  }
  return { initialize: initialize, draft: draft };
});
