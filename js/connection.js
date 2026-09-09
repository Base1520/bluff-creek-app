/* Optional member/guest connection. No form drafts or auth session are persisted. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.CreekConnection = api; api.initialize(root.document); }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.4/dist/umd/supabase.min.js';
  function loopback(address) {
    return ['http:', 'https:'].includes(address.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(address.hostname) && !!address.port && !address.username && !address.password;
  }
  function localAnonKey(key) {
    try { return JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; } catch (_) { return false; }
  }
  function settings(config, location) {
    try {
      var project = new URL(config.supabaseUrl), page = new URL(location.href);
      var local = config.localDevelopment === true && loopback(project) && loopback(page);
      if (config.localDevelopment === true && !local) return null;
      if (project.username || project.password || project.pathname !== '/' || project.search || project.hash) return null;
      if (!local && (project.protocol !== 'https:' || project.port || !/^[a-z0-9-]+\.supabase\.co$/.test(project.hostname))) return null;
      if (typeof config.publishableKey !== 'string' || config.publishableKey.trim() !== config.publishableKey) return null;
      if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey) && !(local && localAnonKey(config.publishableKey || ''))) return null;
      if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.includes(page.origin)) return null;
      if (page.username || page.password || (!local && page.protocol !== 'https:')) return null;
      if (page.pathname !== '/connection.html') return null;
      return { url: project.origin, key: config.publishableKey, redirect: page.origin + '/connection.html' };
    } catch (_) { return null; }
  }
  function consumeRedirect(win) {
    var hash = new URLSearchParams(win.location.hash.slice(1));
    var query = new URLSearchParams(win.location.search);
    var relevant = ['access_token', 'refresh_token', 'error', 'error_description', 'token_hash', 'code'].some(function (key) { return hash.has(key) || query.has(key); });
    if (!relevant) return null;
    var result = { error: true };
    if (hash.get('access_token') && hash.get('refresh_token') && hash.get('token_type') === 'bearer' && !hash.has('error') && !query.has('code') && ['', 'magiclink', 'signup', 'email'].includes(hash.get('type') || '')) {
      result = { access_token: hash.get('access_token'), refresh_token: hash.get('refresh_token') };
    }
    // Remove credentials and provider errors before loading the SDK or rendering UI.
    win.history.replaceState(null, '', win.location.pathname);
    return result;
  }
  function loadSdk(doc) {
    if (doc.defaultView.supabase && typeof doc.defaultView.supabase.createClient === 'function') return Promise.resolve(doc.defaultView.supabase.createClient);
    return new Promise(function (resolve, reject) {
      var timeout = doc.defaultView.setTimeout(function () { script.remove(); reject(new Error('sdk timeout')); }, 15000);
      var script = doc.createElement('script'); script.src = SDK; script.crossOrigin = 'anonymous'; script.referrerPolicy = 'no-referrer';
      script.onload = function () { doc.defaultView.clearTimeout(timeout); var sdk = doc.defaultView.supabase; if (sdk && typeof sdk.createClient === 'function') resolve(sdk.createClient); else reject(new Error('sdk')); };
      script.onerror = function () { doc.defaultView.clearTimeout(timeout); script.remove(); reject(new Error('sdk')); };
      doc.head.appendChild(script);
    });
  }
  function verified(user) { return !!(user && user.id && user.email && user.email_confirmed_at && user.is_anonymous !== true); }
  function returnedRow(data) { return Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data; }
  function initialize(doc, options) {
    options = options || {};
    var win = doc.defaultView, el = function (id) { return doc.getElementById('connection-' + id); };
    if (!el('profile-form')) return null;
    var redirect = consumeRedirect(win), config = settings(options.config || win.CREEK_CONNECTION_CONFIG || {}, win.location);
    var client = null, subscription = null, epoch = 0, activeToken = null, user = null, loaded = false, busy = false, destroyed = false, signingOut = false;
    var profile = el('profile-form'), emailForm = el('email-form');
    function field(name) { return profile.elements.namedItem(name); }
    function current(token) { return !destroyed && token === epoch; }
    function status(message, bad) { el('status').textContent = message || ''; el('status').hidden = !message; el('status').classList.toggle('error', !!bad); }
    function clearPrivate() {
      user = null; loaded = false; busy = false; profile.reset(); el('fields').disabled = false; profile.hidden = true;
      el('account').hidden = true; el('verified-email').textContent = ''; el('retry').hidden = true; el('retry').disabled = false;
      el('email').value = ''; emailForm.querySelector('button').disabled = false;
    }
    function phoneRequired() { field('phone').required = field('preferred_contact').value !== 'email'; }
    function showSignin(message, bad) { el('signin').hidden = false; status(message, bad); }
    async function readProfile(token, verifiedUser) {
      if (!current(token)) return;
      loaded = false; busy = true; el('fields').disabled = true; el('retry').disabled = true;
      var timeout;
      try {
        // Bound the UI wait; a timed-out RPC may still finish on the server.
        var result = await Promise.race([client.rpc('get_my_app_connection'), new Promise(function (_, reject) {
          timeout = win.setTimeout(function () { reject(new Error('profile timeout')); }, 15000);
        })]);
        if (!current(token)) return;
        if (!result || result.error) throw new Error('profile');
        var row = returnedRow(result.data);
        if (row !== null && (typeof row !== 'object' || typeof row.first_name !== 'string' || row.email !== verifiedUser.email)) throw new Error('profile');
        profile.reset();
        if (row) ['first_name', 'last_name', 'phone', 'sunday_school'].forEach(function (name) { field(name).value = row[name] || ''; });
        field('preferred_contact').value = row && ['email', 'phone', 'text'].includes(row.preferred_contact) ? row.preferred_contact : 'email';
        field('contact_permission').checked = false; phoneRequired(); loaded = true; profile.hidden = false; el('retry').hidden = true;
        status(row ? 'Your current connection details are ready to review. Updates will go back to the church team for review.' : 'Your email is verified. Add the details you want to share with our church team.');
      } catch (_) {
        if (!current(token)) return;
        loaded = false; profile.hidden = true; el('retry').hidden = false;
        status('Your details could not load. Please try again before making changes.', true);
      } finally {
        win.clearTimeout(timeout);
        if (current(token)) { busy = false; el('fields').disabled = false; el('retry').disabled = false; }
      }
    }
    async function verifyAndLoad(token) {
      try {
        var result = await client.auth.getUser();
        if (!current(token)) return;
        if (!result || result.error || !verified(result.data && result.data.user)) throw new Error('auth');
        user = result.data.user; el('signin').hidden = true; el('account').hidden = false; el('verified-email').textContent = user.email;
        await readProfile(token, user);
      } catch (_) {
        if (!current(token)) return;
        clearPrivate(); showSignin('We could not verify this sign-in. Request a new email link to continue.', true);
      }
    }
    function adopt(session, force) {
      if (destroyed || signingOut) return;
      var token = session && session.access_token;
      if (!force && token && token === activeToken) return;
      activeToken = token || null; var revision = ++epoch; clearPrivate();
      if (!session) { showSignin(''); return; }
      el('signin').hidden = true; status('Checking your sign-in…');
      // Keep Supabase calls outside its synchronous auth-event callback.
      win.setTimeout(function () { if (current(revision)) verifyAndLoad(revision); }, 0);
    }
    async function signout() {
      var oldClient = client; signingOut = true; ++epoch; activeToken = null; clearPrivate(); status('Your details have been cleared from this page.'); el('signin').hidden = true;
      try {
        var result = await oldClient.auth.signOut({ scope: 'local' });
        if (result && result.error) throw new Error('signout');
        if (!destroyed) { signingOut = false; showSignin('Signed out.'); }
      } catch (_) {
        if (!destroyed) status('Your details are cleared. Close this page to finish signing out; a new sign-in link will be needed when you return.', true);
      }
    }
    profile.addEventListener('change', function (event) { if (event.target.name === 'preferred_contact') phoneRequired(); });
    emailForm.addEventListener('submit', async function (event) {
      event.preventDefault(); if (!client || destroyed || busy || signingOut) return;
      var email = el('email').value.trim(); el('email').value = email;
      if (!emailForm.reportValidity()) return;
      var revision = epoch; busy = true; emailForm.querySelector('button').disabled = true;
      try {
        var result = await client.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true, emailRedirectTo: config.redirect } });
        if (!current(revision)) return;
        if (!result || result.error) throw new Error('otp');
        status('Check your inbox for a sign-in link. Your connection details have not been submitted yet.');
      } catch (_) { if (current(revision)) status('We could not send a sign-in link. Please try again, or use the email connection form below.', true); }
      finally { if (current(revision)) { busy = false; emailForm.querySelector('button').disabled = false; } }
    });
    profile.addEventListener('submit', async function (event) {
      event.preventDefault(); if (!client || !user || !loaded || busy || destroyed || signingOut) return;
      ['first_name', 'last_name', 'phone', 'sunday_school'].forEach(function (name) { field(name).value = field(name).value.trim(); });
      phoneRequired(); if (!profile.reportValidity()) return;
      var revision = epoch, accountId = user.id;
      var payload = { p_first_name: field('first_name').value, p_last_name: field('last_name').value, p_phone: field('phone').value || null,
        p_preferred_contact: field('preferred_contact').value, p_contact_permission: field('contact_permission').checked, p_sunday_school: field('sunday_school').value || null };
      if (!payload.p_first_name || !payload.p_contact_permission || !['email', 'phone', 'text'].includes(payload.p_preferred_contact) || (payload.p_preferred_contact !== 'email' && !payload.p_phone)) return;
      busy = true; el('fields').disabled = true; status('Submitting your details…');
      try {
        var check = await client.auth.getUser();
        if (!current(revision)) return;
        if (!check || check.error || !verified(check.data && check.data.user) || check.data.user.id !== accountId || check.data.user.email !== user.email) {
          ++epoch; activeToken = null; clearPrivate(); showSignin('Your sign-in needs to be verified again. Request a new email link to continue.', true); return;
        }
        var result = await client.rpc('save_app_connection', payload);
        if (!current(revision)) return;
        var saved = result && returnedRow(result.data);
        if (!result || result.error || !saved || typeof saved.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(saved.id) || !Number.isSafeInteger(saved.version) || saved.version < 1) throw new Error('save');
        field('contact_permission').checked = false;
        status('Your details were submitted for staff review. This confirms receipt; it does not mean someone has contacted you yet. You can update your details here.');
      } catch (_) { if (current(revision)) { el('retry').hidden = false; status('We could not confirm your submission. Your entries remain here. Try loading your saved details before submitting again if the connection was interrupted.', true); } }
      finally { if (current(revision)) { busy = false; el('fields').disabled = false; } }
    });
    el('signout').addEventListener('click', signout);
    el('retry').addEventListener('click', function () { if (user && !busy) { var revision = ++epoch; status('Loading your connection details…'); readProfile(revision, user); } });
    function destroy() { destroyed = true; ++epoch; clearPrivate(); status(''); if (subscription) subscription.unsubscribe(); if (client) client.auth.stopAutoRefresh(); client = null; }
    win.addEventListener('pagehide', destroy);
    win.addEventListener('pageshow', function (event) { if (event.persisted) win.location.reload(); });
    var ready = (async function () {
      if (!config) return;
      el('unavailable').hidden = true; status('Preparing secure sign-in…');
      try {
        var createClient = options.createClient || await loadSdk(doc);
        if (destroyed) return;
        client = createClient(config.url, config.key, { auth: { storageKey: 'creek-app-connection-v1', persistSession: false, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'implicit' } });
        subscription = client.auth.onAuthStateChange(function (event, session) {
          if (event === 'TOKEN_REFRESHED' && user && session && session.user && session.user.id === user.id) { activeToken = session.access_token; return; }
          adopt(session, event === 'USER_UPDATED');
        }).data.subscription;
        var revision = epoch, invalidLink = redirect && redirect.error;
        var response = redirect && !redirect.error ? await client.auth.setSession(redirect) : await client.auth.getSession();
        redirect = null;
        if (!current(revision)) return;
        if (!response || response.error) throw new Error('auth');
        adopt(response.data && response.data.session);
        if (invalidLink) status('This sign-in link could not be used. Request a new email link to continue.', true);
      } catch (_) { redirect = null; if (!destroyed) showSignin('Sign-in could not be prepared. Please reload this page or use the email connection form below.', true); }
    })();
    return { ready: ready, destroy: destroy };
  }
  return { initialize: initialize, settings: settings, consumeRedirect: consumeRedirect };
});
