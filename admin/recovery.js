/* Staff password help. No passwords or recovery sessions are persisted. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.CreekRecovery = api; api.initialize(root.document); }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.4/dist/umd/supabase.min.js';
  function loopback(url) { return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !!url.port && !url.username && !url.password; }
  function browserKey(key) {
    if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key || '')) return true;
    try { return key.split('.').length === 3 && JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; } catch (_) { return false; }
  }
  function settings(config, location) {
    try {
      var page = new URL(location.href), backend = new URL(config.supabaseUrl);
      var local = config.localDevelopment === true && loopback(page) && loopback(backend);
      if (config.localDevelopment === true && !local) return null;
      if (page.pathname !== '/admin/recovery.html' || page.username || page.password || (!local && page.protocol !== 'https:')) return null;
      if (backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash) return null;
      if (!local && (backend.protocol !== 'https:' || backend.port || !/^[a-z0-9-]+\.supabase\.co$/.test(backend.hostname))) return null;
      if (!browserKey(config.publishableKey)) return null;
      return { url: backend.origin, key: config.publishableKey, redirect: page.origin + '/admin/recovery.html' };
    } catch (_) { return null; }
  }
  function consumeRedirect(win) {
    if (!win.location.hash && !win.location.search) return null;
    var hash = new URLSearchParams(win.location.hash.slice(1)), query = new URLSearchParams(win.location.search), result = { error: true };
    if (!query.size && ['recovery', 'invite'].includes(hash.get('type')) && hash.get('token_type') === 'bearer' && hash.get('access_token') && hash.get('refresh_token') && !hash.has('error') && !hash.has('error_code') && !hash.has('error_description') && !hash.has('code') && !hash.has('token_hash') && ['type', 'token_type', 'access_token', 'refresh_token'].every(function (key) { return hash.getAll(key).length === 1; })) {
      result = { type: hash.get('type'), access_token: hash.get('access_token'), refresh_token: hash.get('refresh_token') };
    }
    // Scrub even invalid callbacks before loading third-party code. Never log URLs.
    win.history.replaceState(null, '', win.location.pathname);
    return result;
  }
  function loadSdk(doc) {
    if (doc.defaultView.supabase && doc.defaultView.supabase.createClient) return Promise.resolve(doc.defaultView.supabase.createClient);
    return new Promise(function (resolve, reject) {
      var script = doc.createElement('script'), timer = doc.defaultView.setTimeout(function () { script.remove(); reject(new Error('sdk')); }, 15000);
      script.src = SDK; script.crossOrigin = 'anonymous'; script.referrerPolicy = 'no-referrer';
      script.onload = function () { doc.defaultView.clearTimeout(timer); var sdk = doc.defaultView.supabase; if (sdk && sdk.createClient) resolve(sdk.createClient); else reject(new Error('sdk')); };
      script.onerror = function () { doc.defaultView.clearTimeout(timer); script.remove(); reject(new Error('sdk')); };
      doc.head.appendChild(script);
    });
  }
  function initialize(doc, options) {
    options = options || {};
    var win = doc.defaultView, el = function (id) { return doc.getElementById('recovery-' + id); };
    if (!el('request-form')) return null;
    var callback = consumeRedirect(win), config = settings(options.config || win.CREEK_OFFICE_CONFIG || {}, win.location);
    var client = null, subscription = null, phase = 'loading', epoch = 0, owner = null, busy = false, destroyed = false, cleanupStarted = false;
    function current(revision) { return !destroyed && revision === epoch && phase !== 'closed'; }
    function status(message, bad) { el('status').textContent = message; el('status').classList.toggle('error', !!bad); }
    function clearFields() { el('request-form').reset(); el('password-form').reset(); el('account').textContent = ''; }
    function cleanup() {
      if (!client || cleanupStarted) return; cleanupStarted = true;
      // Run after an Auth callback returns; SDK methods must not reenter its lock.
      win.setTimeout(function () {
        var retired = client; client = null;
        if (subscription) { subscription.unsubscribe(); subscription = null; }
        Promise.resolve().then(function () { return retired.auth.stopAutoRefresh(); }).catch(function () {});
        Promise.resolve().then(function () { return retired.auth.signOut({ scope: 'local' }); }).catch(function () {});
      }, 0);
    }
    function close(message, success) {
      epoch++; phase = 'closed'; owner = null; busy = false; callback = null; clearFields();
      el('request').hidden = true; el('password-panel').hidden = true; el('cancel').hidden = true;
      el('save').disabled = true; el('restart').hidden = !!success;
      status(message, !success); cleanup(); el(success ? 'login' : 'restart').focus();
    }
    function timed(request) {
      var timer; return Promise.race([Promise.resolve(request), new Promise(function (_resolve, reject) { timer = win.setTimeout(function () { reject(new Error('timeout')); }, options.timeoutMs || 12000); })]).finally(function () { win.clearTimeout(timer); });
    }
    async function staff(revision, expectedId) {
      var result = await timed(client.auth.getUser());
      if (!current(revision)) return null;
      var user = result && result.data && result.data.user;
      if (!result || result.error || !user || !user.id || !user.email || !user.email_confirmed_at || user.is_anonymous === true || (expectedId && user.id !== expectedId)) throw new Error('identity');
      var access = await timed(client.from('staff_roles').select('role').eq('user_id', user.id).maybeSingle());
      if (!current(revision)) return null;
      if (!access || access.error || !access.data || !['admin', 'editor', 'viewer'].includes(access.data.role)) throw new Error('staff');
      return user;
    }
    el('request-form').addEventListener('submit', async function (event) {
      event.preventDefault(); if (!client || phase !== 'request' || busy || destroyed) return;
      var email = el('email').value.trim(); el('email').value = email;
      if (!el('request-form').reportValidity()) return;
      var revision = epoch; busy = true; el('send').disabled = true;
      try { await timed(client.auth.resetPasswordForEmail(email, { redirectTo: config.redirect })); } catch (_) {}
      if (!current(revision)) return;
      email = ''; el('email').value = ''; busy = false; el('send').disabled = false;
      // Identical response for existing/unknown accounts and provider failures.
      status('Check your inbox for a reset link. If no link arrives, try again later or ask your workspace administrator for help.');
    });
    el('password-form').addEventListener('submit', async function (event) {
      event.preventDefault(); if (!client || phase !== 'password' || busy || !owner || destroyed) return;
      if (!el('password-form').reportValidity()) return;
      if (el('password').value.length < 12 || el('password').value !== el('confirm').value) { status('Use at least 12 characters and enter the same password in both fields.', true); el('confirm').focus(); return; }
      var revision = epoch, expectedId = owner, password = el('password').value;
      busy = true; el('save').disabled = true; el('password').disabled = true; el('confirm').disabled = true;
      status('Checking access and saving your password…');
      try {
        var user = await staff(revision, expectedId);
        if (!user || !current(revision)) return;
        var operation = client.auth.updateUser({ password: password }); password = ''; el('password-form').reset();
        var result = await timed(operation);
        if (!current(revision)) return;
        if (!result || result.error || !result.data || !result.data.user || result.data.user.id !== expectedId) throw new Error('update');
        close('Your password was saved. Return to staff sign in and enter your email and new password.', true);
      } catch (_) {
        if (current(revision)) close('We could not confirm the password change. Try staff sign in with your new password, or request a fresh link. If access is unavailable, ask your workspace administrator.', false);
      } finally { password = ''; if (!destroyed) el('password-form').reset(); }
    });
    el('cancel').addEventListener('click', function () { close(busy ? 'Password setup is closed. A submitted change may still finish; try staff sign in before requesting another link.' : 'Password setup is closed. Request a fresh link when you are ready.', false); });
    el('login').addEventListener('click', function () {
      // Returning to manual sign-in must not restore an older office account in this tab.
      ['creek-office-auth', 'creek-office-auth-code-verifier', 'creek-office-auth-user'].forEach(function (key) { try { win.sessionStorage.removeItem(key); } catch (_) {} });
    });
    function destroy() { destroyed = true; epoch++; phase = 'closed'; owner = null; callback = null; clearFields(); el('password-panel').hidden = true; if (subscription) subscription.unsubscribe(); cleanup(); }
    win.addEventListener('pagehide', destroy);
    win.addEventListener('pageshow', function (event) { if (event.persisted) win.location.reload(); });
    var ready = (async function () {
      if (!config) { callback = null; status('Password help is not connected yet. Ask your workspace administrator to finish the office setup.', true); return; }
      if (callback && callback.error) { close('This link is invalid, expired or already used. Request a fresh link to continue.', false); return; }
      try {
        var createClient = options.createClient || await loadSdk(doc);
        if (destroyed) return;
        client = createClient(config.url, config.key, { auth: { storageKey: 'creek-office-recovery-v1', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'implicit' } });
        subscription = client.auth.onAuthStateChange(function (event, next) {
          if (destroyed || phase === 'closed') return;
          if (event === 'SIGNED_OUT' || (owner && next && (!next.user || next.user.id !== owner))) close('Your sign-in changed. Request a fresh password link to continue.', false);
        }).data.subscription;
        if (!callback) { phase = 'request'; el('request').hidden = false; status('Request a password reset for your approved staff account.'); return; }
        phase = 'verifying'; el('cancel').hidden = false; var revision = epoch, kind = callback.type;
        var tokens = { access_token: callback.access_token, refresh_token: callback.refresh_token }; callback = null;
        var operation = client.auth.setSession(tokens); tokens = null;
        var response = await timed(operation);
        if (!current(revision)) return;
        if (!response || response.error || !response.data || !response.data.session || !response.data.session.user) throw new Error('link');
        owner = response.data.session.user.id;
        var user = await staff(revision, owner);
        if (!user || !current(revision)) return;
        phase = 'password'; el('title').textContent = kind === 'invite' ? 'Set your staff password.' : 'Choose a new password.';
        el('account').textContent = 'Staff account: ' + user.email; el('password-panel').hidden = false;
        status('Your email link and current staff access have been checked.'); el('password').focus();
      } catch (_) { if (!destroyed && phase !== 'closed') close('This link or staff access could not be verified. Request a fresh link, or ask your workspace administrator to check your access.', false); }
    })();
    return { ready: ready, destroy: destroy };
  }
  return { settings: settings, consumeRedirect: consumeRedirect, initialize: initialize };
});
