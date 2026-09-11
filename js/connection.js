/* Direct public intake. Drafts are memory-only; the optional public Auth session is isolated from Office. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.CreekConnection = api; api.initialize(root.document); }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.4/dist/umd/supabase.min.js';
  var SESSION_KEY = 'creek-public-intake-v1', REMEMBER_KEY = 'creek-public-intake-remember-v1';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function loopback(address) {
    return ['http:', 'https:'].includes(address.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(address.hostname) && !!address.port && !address.username && !address.password;
  }
  function localAnonKey(key) {
    try { return JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; } catch (_) { return false; }
  }
  function settings(config, location) {
    try {
      if (config.enabled !== true) return null;
      var project = new URL(config.supabaseUrl), page = new URL(location.href);
      var local = config.localDevelopment === true && loopback(project) && loopback(page);
      if (config.localDevelopment === true && !local) return null;
      if (project.username || project.password || project.pathname !== '/' || project.search || project.hash) return null;
      if (!local && (project.protocol !== 'https:' || project.port || !/^[a-z0-9-]+\.supabase\.co$/.test(project.hostname))) return null;
      if (typeof config.publishableKey !== 'string' || config.publishableKey.trim() !== config.publishableKey) return null;
      if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey) && !(local && localAnonKey(config.publishableKey || ''))) return null;
      if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.includes(page.origin)) return null;
      if (page.username || page.password || (!local && page.protocol !== 'https:')) return null;
      if (!['/', '/index.html', '/connection.html'].includes(page.pathname)) return null;
      return { url: project.origin, key: config.publishableKey, redirect: page.origin + '/connection.html' };
    } catch (_) { return null; }
  }
  function consumeRedirect(win) {
    var keys = ['access_token','refresh_token','error','error_code','error_description','token_hash','code'];
    var hash = new URLSearchParams(win.location.hash.slice(1)), query = new URLSearchParams(win.location.search);
    if (!keys.some(function (key) { return hash.has(key) || query.has(key); }) && !hash.has('type')) return null;
    var result = { error: true };
    if (win.location.pathname === '/connection.html' && !query.size && hash.get('type') === 'recovery' && hash.get('token_type') === 'bearer' && hash.get('access_token') && hash.get('refresh_token') && !['error','error_code','error_description','code','token_hash'].some(function (key) { return hash.has(key); }) && ['type','token_type','access_token','refresh_token'].every(function (key) { return hash.getAll(key).length === 1; })) {
      result = { access_token: hash.get('access_token'), refresh_token: hash.get('refresh_token') };
    }
    // Scrub even invalid links before loading the SDK. Invite/signup links never enter public recovery.
    win.history.replaceState(null, '', win.location.pathname); return result;
  }
  function sessionStore(win) {
    var memory = null, remember = false, blocked = false;
    try { remember = win.localStorage.getItem(REMEMBER_KEY) === 'yes'; } catch (_) {}
    function remove() { try { win.localStorage.removeItem(SESSION_KEY); win.localStorage.removeItem(REMEMBER_KEY); } catch (_) {} }
    return {
      get remembered() { return remember; },
      choose: function (value) { blocked = false; remember = value === true; if (!remember) remove(); },
      clear: function () { blocked = true; memory = null; remember = false; remove(); },
      storage: {
        getItem: function (key) { if (key !== SESSION_KEY) return null; if (remember) { try { return win.localStorage.getItem(key); } catch (_) {} } return memory; },
        setItem: function (key, value) { if (key !== SESSION_KEY || blocked) return; memory = value; if (remember) { try { win.localStorage.setItem(key, value); win.localStorage.setItem(REMEMBER_KEY, 'yes'); } catch (_) { remove(); remember = false; } } },
        removeItem: function (key) { if (key === SESSION_KEY) { memory = null; remove(); } }
      }
    };
  }
  function loadSdk(doc) {
    if (doc.defaultView.supabase && typeof doc.defaultView.supabase.createClient === 'function') return Promise.resolve(doc.defaultView.supabase.createClient);
    return new Promise(function (resolve, reject) {
      var script = doc.createElement('script');
      var timer = doc.defaultView.setTimeout(function () { script.remove(); reject(new Error('sdk')); }, 15000);
      script.src = SDK; script.crossOrigin = 'anonymous'; script.referrerPolicy = 'no-referrer';
      script.onload = function () { doc.defaultView.clearTimeout(timer); var sdk = doc.defaultView.supabase; if (sdk && typeof sdk.createClient === 'function') resolve(sdk.createClient); else reject(new Error('sdk')); };
      script.onerror = function () { doc.defaultView.clearTimeout(timer); script.remove(); reject(new Error('sdk')); };
      doc.head.appendChild(script);
    });
  }
  function eligible(user) { return !!(user && UUID.test(user.id || '') && typeof user.email === 'string' && user.email.trim() && user.is_anonymous !== true); }
  function row(data) { return Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data; }
  function receipt(data, kind) {
    var value = row(data);
    return value && UUID.test(value.id || '') && typeof value.submitted_at === 'string' && Number.isFinite(Date.parse(value.submitted_at)) && (kind === 'prayer' || (Number.isSafeInteger(value.version) && value.version > 0 && ['queued','sending','sent','attention'].includes(value.welcome_email_status))) ? value : null;
  }
  function recover(doc, options, config, callback) {
    var win = doc.defaultView, el = function (id) { return doc.getElementById('connection-' + id); };
    // Returning from password recovery must not restore another remembered public account.
    sessionStore(win).clear();
    var client = null, subscription = null, owner = null, epoch = 0, phase = 'verifying', busy = false, destroyed = false;
    function current(token) { return !destroyed && phase !== 'closed' && token === epoch; }
    function status(message) { el('recovery-status').textContent = message; }
    function timed(promise) { var timer; return Promise.race([promise, new Promise(function (_, reject) { timer = win.setTimeout(function () { reject(new Error('deadline')); }, options.timeoutMs || 15000); })]).finally(function () { win.clearTimeout(timer); }); }
    function cleanClient() { if (subscription) subscription.unsubscribe(); var retired = client; client = null; if (retired) win.setTimeout(function () { Promise.resolve().then(function () { return retired.auth.signOut({scope:'local'}); }).catch(function () {}); if (retired.auth.stopAutoRefresh) retired.auth.stopAutoRefresh(); }, 0); }
    function close(message) { epoch++; phase = 'closed'; owner = null; callback = null; busy = false; el('recovery-form').reset(); el('recovery-fields').hidden = true; el('recovery-cancel').hidden = true; el('recovery-return').hidden = false; status(message); cleanClient(); }
    async function identity(token) { var result = await timed(client.auth.getUser()); if (!current(token)) return null; var found = result && !result.error && result.data && result.data.user; if (!eligible(found) || found.id !== owner) throw new Error('identity'); return found; }
    var appShell = doc.querySelector('.connection-app, .app'); if (appShell) appShell.hidden = true;
    el('recovery').hidden = false; el('recovery-fields').hidden = true; el('recovery-return').hidden = true;
    el('recovery-form').addEventListener('submit', async function (event) {
      event.preventDefault(); if (!client || phase !== 'password' || busy || !el('recovery-form').reportValidity()) return;
      var password = el('new-password').value;
      if (password.length < 12 || password !== el('confirm-password').value) { status('Use at least 12 characters and enter the same password in both fields.'); return; }
      busy = true; el('recovery-fields').disabled = true; var token = epoch;
      try { if (!await identity(token)) return; var operation = client.auth.updateUser({password:password}); password = ''; el('recovery-form').reset(); var result = await timed(operation); if (!current(token)) return; if (!result || result.error || !result.data || !result.data.user || result.data.user.id !== owner) throw new Error('password'); close('Your password was saved. Return to the app and sign in with your email and new password.'); }
      catch (_) { if (current(token)) close('We could not confirm the password change. Try signing in with your new password, or request a fresh reset link.'); }
      finally { password = ''; el('recovery-form').reset(); }
    });
    el('recovery-cancel').addEventListener('click', function () { close(busy ? 'Password setup is closed. A submitted password change may still finish. Try signing in before requesting another link.' : 'Password setup is closed. Request a fresh link when you are ready.'); });
    function destroy() { if (destroyed) return; close('Password setup is closed.'); destroyed = true; }
    win.addEventListener('pagehide', destroy); win.addEventListener('pageshow', function (event) { if (event.persisted) win.location.reload(); });
    var ready = (async function () {
      if (!config || callback.error) { close('This password link is invalid or password help is not connected. Return to the app to request a fresh reset link.'); return; }
      try {
        var create = options.createClient || await loadSdk(doc); if (destroyed) return;
        client = create(config.url, config.key, {auth:{storageKey:'creek-public-recovery-v1',persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,flowType:'implicit'}});
        subscription = client.auth.onAuthStateChange(function (event, next) { if (phase !== 'closed' && (event === 'SIGNED_OUT' || (owner && next && (!next.user || next.user.id !== owner)))) close('Your account changed. Request a fresh reset link.'); }).data.subscription;
        var token = epoch, tokens = callback; callback = null; var operation = client.auth.setSession(tokens); tokens = null;
        var result = await timed(operation); if (!current(token)) return;
        if (!result || result.error || !result.data || !result.data.session || !eligible(result.data.session.user)) throw new Error('session');
        owner = result.data.session.user.id; if (!await identity(token)) return;
        phase = 'password'; el('recovery-fields').hidden = false; status('Choose a new password for your app account.'); el('new-password').focus();
      } catch (_) { if (current(epoch)) close('This password link could not be verified. It may be expired or already used. Request a fresh link.'); }
    })();
    return {ready:ready,destroy:destroy};
  }
  function initialize(doc, options) {
    options = options || {};
    var win = doc.defaultView, el = function (id) { return doc.getElementById('connection-' + id); };
    if (!el('guest-form') || !el('auth-form')) return null;
    var autoOnboard = win.CREEK_PROFILE_ENTRY === true || (win.CREEK_PROFILE_ENTRY === undefined && ['/', '/index.html'].includes(win.location.pathname) && !win.location.hash);
    var stripped = consumeRedirect(win), config = settings(options.config || win.CREEK_CONNECTION_CONFIG || {}, win.location);
    if (stripped) return recover(doc, options, config, stripped);
    var store = sessionStore(win), client = null, subscription = null, user = null, epoch = 0, destroyed = false, authBusy = false, authUncertain = false, authPending = false, signingOut = false, reading = false, loaded = false, guestRemoved = false;
    el('remember').checked = store.remembered;
    var resetBusy = false, pendingSubmit = null, pendingOnboarding = null, waitingForDocument = false;
    var authForm = el('auth-form'), dialog = el('dialog'), modes = { guest: makeMode('guest'), prayer: makeMode('prayer') };
    var preferences = { capability: 'checking', reading: false, loaded: false, busy: false, value: null, dirty: false, guestTouched: false, attempt: null, serial: 0 };
    var preferenceForm = el('preferences-form');
    function makeMode(kind) { var form = el(kind + '-form'); return { kind: kind, form: form, fields: form.querySelector('fieldset'), dirty: false, busy: false, attempt: null, saved: null, serial: 0, extraTouched: new Set() }; }
    function field(form, key) { return form.elements.namedItem(key); }
    var extraKeys = ['birth_date','membership_status','address_line1','address_line2','city','state_region','postal_code','family_members'];
    var memberships = ['member','regular_attender','guest','exploring','unsure'];
    var relationships = ['spouse','child','parent','guardian','other'];
    function today() {
      var parts = new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(options.now ? options.now() : new Date());
      var part = function (type) { return parts.find(function (item) { return item.type === type; }).value; };
      return part('year') + '-' + part('month') + '-' + part('day');
    }
    function validBirth(value) { return !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0,10) === value && value <= today()); }
    function familyRows() { return Array.from(el('family-rows').querySelectorAll('[data-family-row]')); }
    function resetExtras() { modes.guest.extraTouched.clear(); el('family-rows').replaceChildren(); field(modes.guest.form,'phone').required = false; }
    function dirtyExtra(key) { modes.guest.extraTouched.add(key); modes.guest.dirty = true; modes.guest.saved = null; modes.guest.serial++; draw(); }
    function addFamily(value, touched) {
      if (familyRows().length >= 20) return;
      var group = doc.createElement('fieldset'); group.className = 'connection-family-row'; group.dataset.familyRow = '';
      var legend = doc.createElement('legend'); legend.textContent = 'Family member'; group.appendChild(legend);
      function input(label, key, type, required, max, autocomplete) {
        var wrapper = doc.createElement('label'); wrapper.textContent = label;
        var node = doc.createElement(type === 'select' ? 'select' : 'input'); node.dataset.familyField = key;
        if (type !== 'select') node.type = type; node.required = !!required;
        if (max) node.maxLength = max; node.autocomplete = autocomplete || 'off';
        if (type === 'date') node.max = today();
        if (type === 'select') [{value:'',label:'Choose a relationship'}].concat(relationships.map(function (item) { return {value:item,label:item.charAt(0).toUpperCase()+item.slice(1)}; })).forEach(function (item) { var option = doc.createElement('option'); option.value = item.value; option.textContent = item.label; node.appendChild(option); });
        node.value = value && typeof value[key] === 'string' ? value[key] : ''; wrapper.appendChild(node); group.appendChild(wrapper);
      }
      input('First name','first_name','text',true,100); input('Last name (optional)','last_name','text',false,100);
      input('Relationship to you','relationship','select',true); input('Birthday (optional)','birth_date','date',false);
      var remove = doc.createElement('button'); remove.type = 'button'; remove.className = 'connection-quiet'; remove.textContent = 'Remove family member';
      remove.addEventListener('click', function () { if (modes.guest.attempt || modes.guest.busy || reading) return; group.remove(); dirtyExtra('family_members'); });
      group.appendChild(remove); el('family-rows').appendChild(group); if (touched) dirtyExtra('family_members');
    }
    function extendedProfile(data) {
      extraKeys.forEach(function (key) {
        if (modes.guest.extraTouched.has(key) || !Object.prototype.hasOwnProperty.call(data,key)) return;
        var value = data[key];
        if (key === 'family_members') {
          if (!Array.isArray(value) || value.length > 20 || value.some(function (member) { return !member || typeof member.first_name !== 'string' || !member.first_name.trim() || member.first_name.length > 100 || !relationships.includes(member.relationship) || (member.last_name != null && (typeof member.last_name !== 'string' || member.last_name.length > 100)) || (member.birth_date != null && (typeof member.birth_date !== 'string' || !validBirth(member.birth_date))); })) throw new Error('profile');
          el('family-rows').replaceChildren(); value.forEach(function (member) { addFamily(member, false); }); return;
        }
        if (value !== null && typeof value !== 'string') throw new Error('profile');
        if (key === 'membership_status' && !memberships.includes(value)) throw new Error('profile');
        if (key === 'birth_date' && !validBirth(value)) throw new Error('profile');
        field(modes.guest.form,key).value = value || '';
      });
    }
    function extraPayload() {
      var values = {}, touched = modes.guest.extraTouched;
      for (var key of extraKeys) {
        if (!touched.has(key)) continue;
        if (key === 'family_members') {
          var members = familyRows(); if (members.length > 20) throw new Error('family');
          values[key] = members.map(function (group) {
            var read = function (name) { return group.querySelector('[data-family-field="' + name + '"]').value.trim(); };
            var member = {first_name:read('first_name'),last_name:read('last_name'),relationship:read('relationship'),birth_date:read('birth_date') || null};
            if (!member.first_name || member.first_name.length > 100 || member.last_name.length > 100 || !relationships.includes(member.relationship) || !validBirth(member.birth_date)) throw new Error('family'); return member;
          });
        } else {
          var value = field(modes.guest.form,key).value.trim();
          if (key === 'birth_date' && !validBirth(value)) throw new Error('birthday');
          if (key === 'membership_status' && !memberships.includes(value)) throw new Error('membership');
          values[key] = value || null;
        }
      }
      return values;
    }
    function onboarding(needed) {
      if (!autoOnboard) return;
      pendingOnboarding = { needed: needed, token: epoch };
      // The account script may finish before index.html installs its router.
      // Recheck the latest account/navigation state after all parser scripts run.
      if (doc.readyState === 'loading') {
        if (!waitingForDocument) {
          waitingForDocument = true;
          doc.addEventListener('DOMContentLoaded', function () {
            waitingForDocument = false; var pending = pendingOnboarding; pendingOnboarding = null;
            if (pending && current(pending.token)) onboarding(pending.needed);
          }, { once: true });
        }
        return;
      }
      pendingOnboarding = null; autoOnboard = false; win.CREEK_PROFILE_ENTRY = false;
      if (needed) win.dispatchEvent(new win.CustomEvent('creek:open-profile'));
    }
    win.addEventListener('creek:navigation', function () { autoOnboard = false; });
    win.addEventListener('popstate', function () { autoOnboard = false; });
    win.addEventListener('hashchange', function () { autoOnboard = false; });
    function current(token) { return !destroyed && epoch === token; }
    function status(id, message, bad) { var nodes = id === 'availability' ? doc.querySelectorAll('[data-connection-availability]') : [el(id)]; nodes.forEach(function (node) { node.textContent = message || ''; node.hidden = !message; node.classList.toggle('error', !!bad); }); }
    function bounded(promise) { var timer; return Promise.race([promise, new Promise(function (_, reject) { timer = win.setTimeout(function () { reject(new Error('deadline')); }, options.timeoutMs || 15000); })]).finally(function () { win.clearTimeout(timer); }); }
    function hasDraft() { return preferences.dirty || preferences.busy || preferences.attempt || Object.values(modes).some(function (mode) { return mode.dirty || mode.busy || mode.attempt; }); }
    function preferenceBlocked() { return preferences.capability !== 'absent' && (preferences.capability !== 'available' || (!!user && (!preferences.loaded || preferences.reading || preferences.busy || !!preferences.attempt || preferences.dirty))); }
    function beforeUnload(event) { if (hasDraft()) { event.preventDefault(); event.returnValue = true; } }
    function draw() {
      Object.values(modes).forEach(function (mode) {
        mode.fields.disabled = !client || !!mode.attempt || mode.busy || (mode.kind === 'guest' && (guestRemoved || reading || preferences.reading || preferences.busy || !!preferences.attempt));
        var button = el(mode.kind + '-submit');
        button.disabled = !client || mode.busy || (!user && (authBusy || authPending || authUncertain)) || (mode.kind === 'guest' && (guestRemoved || reading || (!!user && !loaded) || preferenceBlocked()));
        button.textContent = mode.attempt && mode.attempt.started ? 'Check and retry this submission' : mode.kind === 'guest' ? 'Save my registration' : 'Send prayer request';
        el(mode.kind + '-new').hidden = !mode.saved;
      });
      doc.querySelectorAll('[data-connection-account]').forEach(function (button) { button.disabled = !client; button.textContent = user ? 'Your account' : 'Create account / Sign in'; });
      el('identity').textContent = user ? 'Signed in as ' + user.email : 'Sign in to send your details securely to the church office.';
      el('signout').hidden = !user && !authUncertain; el('signout').disabled = signingOut;
      el('auth-fields').hidden = !!user;
      el('auth-fields').disabled = authBusy || authUncertain || signingOut || authPending || !client;
      el('auth-check').hidden = !authUncertain; el('auth-check').disabled = authBusy || authPending;
      el('retry-profile').hidden = !user || (loaded && !guestRemoved); el('retry-profile').disabled = reading;
      el('auth-submit').textContent = el('auth-mode').value === 'signup' ? (pendingSubmit ? 'Create account & send' : 'Create my account') : (pendingSubmit ? 'Sign in & send' : 'Sign in');
      el('reset-send').disabled = !client || resetBusy; el('reset-open').hidden = !!user;
      el('open-app').hidden = !modes.guest.saved; el('family-add').disabled = familyRows().length >= 20; el('family-limit').hidden = familyRows().length < 20; field(modes.guest.form,'birth_date').max = today();
      el('weekly-choice').hidden = preferences.capability !== 'available';
      el('preferences').hidden = !user || preferences.capability !== 'available';
      var guestLocked = modes.guest.busy || !!modes.guest.attempt;
      preferenceForm.querySelector('fieldset').disabled = !user || !preferences.loaded || preferences.reading || preferences.busy || !!preferences.attempt || guestLocked;
      el('preferences-submit').disabled = !client || !user || preferences.reading || preferences.busy || guestLocked || (!preferences.attempt && (!preferences.loaded || !preferences.dirty));
      el('preferences-submit').textContent = preferences.attempt ? 'Check and retry email choice' : 'Save email choice';
      el('communication-retry').hidden = preferences.capability !== 'unavailable' && !(user && preferences.capability === 'available' && !preferences.loaded);
      el('communication-retry').disabled = preferences.capability === 'checking' || preferences.reading || preferences.busy || !!preferences.attempt || (guestLocked && !!modes.guest.attempt && modes.guest.attempt.started);
      win.removeEventListener('beforeunload', beforeUnload);
      if (hasDraft()) win.addEventListener('beforeunload', beforeUnload);
    }
    function clearPrivate() {
      pendingSubmit = null; user = null; loaded = false; guestRemoved = false; reading = false; authForm.reset(); el('remember').checked = store.remembered; el('password').autocomplete = 'new-password'; el('password').minLength = 12; el('auth-submit').textContent = 'Create my account'; authBusy = false; authUncertain = false;
      Object.values(modes).forEach(function (mode) { mode.serial++; mode.form.reset(); mode.dirty = false; mode.busy = false; mode.attempt = null; mode.saved = null; status(mode.kind + '-status', ''); });
      preferences.serial++; preferences.loaded = false; preferences.reading = false; preferences.busy = false; preferences.value = null; preferences.dirty = false; preferences.guestTouched = false; preferences.attempt = null; preferenceForm.reset(); status('preferences-status', ''); status('communication-status', '');
      resetExtras(); status('auth-status', ''); status('profile-status', ''); status('reset-status', ''); el('reset-form').reset(); el('reset-form').hidden = true; resetBusy = false; closeDialog(); draw();
    }
    function loseIdentity(message) { epoch++; store.clear(); clearPrivate(); status('auth-status', message || 'Your account changed. Sign in again before sending.', true); }
    function cancelIntent(keepAttempt) {
      var intent = pendingSubmit; pendingSubmit = null;
      if (!keepAttempt) Object.values(modes).forEach(function (mode) { if (mode.attempt && !mode.attempt.started && !mode.busy) mode.attempt = null; });
      draw();
    }
    function openDialog() { if (!client) return; if (!dialog.open) { if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', ''); } }
    function closeDialog() { el('password').value = ''; if (dialog.close) dialog.close(); else dialog.removeAttribute('open'); }
    async function verify(token, owner) {
      var result = await bounded(client.auth.getUser());
      if (!current(token)) return null;
      if (!result || result.error) { if (result && result.error && [401,403].includes(result.error.status)) loseIdentity('Please sign in again before sending.'); throw new Error('identity'); }
      if (!eligible(result.data && result.data.user)) { loseIdentity('Your account is unavailable. Sign in again before sending.'); return null; }
      var confirmed = result.data.user;
      if ((owner && confirmed.id !== owner) || (user && (confirmed.id !== user.id || confirmed.email !== user.email))) { loseIdentity('Your account or email changed. Sign in again and review your choices.'); return null; }
      return confirmed;
    }
    function preferenceValue(data) {
      var value = row(data);
      if (!value || value.version !== 1 || !Number.isSafeInteger(value.preference_version) || value.preference_version < 0 || typeof value.weekly_email !== 'boolean' || typeof value.email_matches !== 'boolean' || (value.updated_at !== null && (typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at)))) || (!value.email_matches && value.weekly_email) || (value.preference_version === 0 && (value.weekly_email || !value.email_matches || value.updated_at !== null)) || (value.preference_version > 0 && value.updated_at === null)) return null;
      return value;
    }
    function communicationConflict(error) { return error && error.code === '40001' && ['COMMUNICATION_VERSION_CONFLICT','COMMUNICATION_REQUEST_CONFLICT','REQUEST_ID_CONFLICT'].includes(error.message); }
    function communicationRateLimit(error) { return error && error.code === 'P0001' && error.message === 'COMMUNICATION_RATE_LIMIT'; }
    async function readCapabilities(token) {
      preferences.capability = 'checking'; draw();
      try {
        var result = await bounded(client.rpc('get_app_communication_capabilities'));
        if (destroyed) return;
        if (result && result.error && result.error.code === 'PGRST202') { preferences.capability = 'absent'; status('communication-status', ''); return; }
        if (!result || result.error || !result.data || result.data.version !== 1 || result.data.weekly_email !== true) throw new Error('capability');
        preferences.capability = 'available'; status('communication-status', '');
      } catch (_) { if (!destroyed) { preferences.capability = 'unavailable'; status('communication-status', 'Email choices could not be checked. Reload them before saving your registration. Prayer requests are still available.', true); } }
      finally { if (!destroyed) draw(); }
    }
    async function readPreferences(token) {
      if (!current(token) || !user || preferences.capability !== 'available' || preferences.reading || preferences.busy || preferences.attempt || modes.guest.busy || (modes.guest.attempt && modes.guest.attempt.started)) return;
      var serial = ++preferences.serial, owner = user.id; preferences.reading = true; preferences.loaded = false;
      status('communication-status', 'Loading your email choice…'); draw();
      try {
        if (!await verify(token, owner)) return;
        var result = await bounded(client.rpc('get_my_communication_preferences'));
        if (!current(token) || preferences.serial !== serial) return;
        var value = result && !result.error && preferenceValue(result.data); if (!value) throw new Error('preference');
        preferences.value = value; preferences.loaded = true;
        if (!preferences.dirty) field(preferenceForm, 'weekly_email').checked = value.weekly_email;
        if (!preferences.guestTouched) field(modes.guest.form, 'weekly_email').checked = value.weekly_email;
        status('communication-status', value.email_matches ? '' : 'Your email has changed. Weekly updates are off for this address. Choose them again if you would like to receive them.');
        status('preferences-status', preferences.dirty ? 'Your unsaved email choice is still here. Review it before saving.' : value.weekly_email ? 'Your current choice is on. Weekly church emails may be sent when available.' : 'Your current choice is off. You can still receive personal care and registration messages.');
      } catch (_) { if (current(token) && preferences.serial === serial) status('communication-status', 'Your saved email choice could not be loaded. Reload it before changing it or saving a registration. Prayer requests are still available.', true); }
      finally { if (current(token) && preferences.serial === serial) { preferences.reading = false; draw(); } }
    }
    function guestPreference() { return preferences.capability === 'available' ? { weekly: field(modes.guest.form, 'weekly_email').checked, touched: preferences.guestTouched, version: user && preferences.loaded ? preferences.value.preference_version : null } : null; }
    async function savePreference() {
      if (!client || !user || destroyed || preferences.capability !== 'available' || preferences.reading || preferences.busy || modes.guest.busy || modes.guest.attempt || (!preferences.attempt && (!preferences.loaded || !preferences.dirty))) return;
      var token = epoch, owner = user.id, serial = ++preferences.serial;
      if (!preferences.attempt) preferences.attempt = { id: win.crypto.randomUUID(), owner: owner, weekly: field(preferenceForm,'weekly_email').checked, version: preferences.value.preference_version };
      var attempt = preferences.attempt;
      if (attempt.owner !== owner) { loseIdentity(); return; }
      preferences.busy = true; status('preferences-status', 'Saving your email choice…'); draw();
      var refresh = false, conflicted = false, limited = false;
      try {
        if (!await verify(token, owner)) return;
        var result = await bounded(client.rpc('set_my_communication_preferences', {p_request_id:attempt.id,p_expected_version:attempt.version,p_weekly_email:attempt.weekly}));
        if (!current(token) || preferences.serial !== serial || preferences.attempt !== attempt) return;
        if (communicationConflict(result && result.error)) {
          preferences.attempt = null; preferences.loaded = false; refresh = true; conflicted = true;
          status('preferences-status', 'Your saved choice changed elsewhere. Review the current choice before saving again.', true); return;
        }
        if (communicationRateLimit(result && result.error)) { preferences.attempt = null; preferences.loaded = false; refresh = true; limited = true; return; }
        var value = result && !result.error && preferenceValue(result.data);
        if (!value || value.preference_version !== attempt.version + 1 || value.weekly_email !== attempt.weekly || !value.email_matches) throw new Error('receipt');
        preferences.attempt = null; preferences.dirty = false; preferences.loaded = false; refresh = true;
        // Replays prove the original operation only. A fresh read supplies current settings.
        status('preferences-status', 'Email choice saved. Checking the current setting…');
      } catch (_) { if (current(token) && preferences.serial === serial) status('preferences-status', 'We could not confirm your email choice. Check and retry to safely repeat this same choice.', true); }
      finally { if (current(token) && preferences.serial === serial) { preferences.busy = false; draw(); if (refresh) { await readPreferences(token); if (current(token) && preferences.loaded) { if (conflicted) status('preferences-status', 'Your saved choice changed elsewhere. The checkbox keeps your unsaved choice; review it and save again to apply it.', true); if (limited) status('preferences-status', 'This save did not change your email choice. Wait before turning weekly emails on again. You can still turn them off now.', true); } } } }
    }
    async function readProfile(token) {
      if (!current(token) || !user || reading || (modes.guest.attempt && modes.guest.attempt.started) || modes.guest.busy) return;
      reading = true; loaded = false; var owner = user.id, serial = ++modes.guest.serial;
      status('profile-status', 'Loading your saved registration…'); draw();
      try {
        if (!await verify(token, owner)) return;
        var result = await bounded(client.rpc('get_my_app_connection'));
        if (!current(token) || serial !== modes.guest.serial) return;
        if (!result || result.error) throw new Error('read');
        var data = row(result.data);
        if (result.data !== null && (!data || typeof data.first_name !== 'string' || data.email !== user.email)) throw new Error('read');
        if (data && !modes.guest.dirty) {
          ['first_name','last_name','phone','preferred_contact','sunday_school','visit_status','first_visit_on'].forEach(function (key) { if (typeof data[key] === 'string') field(modes.guest.form, key).value = data[key]; });
          field(modes.guest.form, 'contact_permission').checked = false;
        }
        if (data) extendedProfile(data);
        var previouslyRemoved=guestRemoved;guestRemoved=!!(data&&data.guest_removed===true);
        if(previouslyRemoved&&data&&!guestRemoved)status('guest-status','The office restored this registration. Review your saved details before making changes.');
        loaded = true; onboarding(!data); status('profile-status', guestRemoved ? 'The office removed this guest registration. Your login still works. Ask the office to restore the visit if needed; you can still send a prayer request.' : data ? (modes.guest.dirty ? 'You have a saved registration. The details you entered here are still in the form; review them before saving an update.' : 'Your saved details are ready to review. Confirm contact permission before saving an update.') : '');
      } catch (_) { if (current(token) && serial === modes.guest.serial) status('profile-status', 'Your saved details could not be loaded. Try again before saving a registration. You can still send a prayer request.', true); }
      finally { if (current(token) && serial === modes.guest.serial) { reading = false; draw(); } }
    }
    async function adopt(session, preserveDraft) {
      var next = session && session.user;
      if (!session || !eligible(next)) { if (user || session) loseIdentity('Please sign in with your email and password.'); return; }
      if (user && user.id === next.id) return;
      if (user || !preserveDraft) { epoch++; clearPrivate(); }
      var token = epoch;
      try {
        var confirmed = await verify(token, next.id); if (!confirmed || !current(token)) return;
        user = confirmed; authUncertain = false; status('auth-status', 'You’re signed in. Review your form, then send it when you’re ready.'); draw(); closeDialog(); await Promise.all([readProfile(token), readPreferences(token)]);
      } catch (_) { if (current(token)) { loseIdentity('We could not confirm your account. Sign in again before sending.'); } }
    }
    async function signout() {
      if (!client || signingOut) return;
      signingOut = true; epoch++; store.clear(); clearPrivate(); var token = epoch;
      var operation;
      try {
        operation = Promise.resolve(client.auth.signOut({ scope: 'local' }));
        operation.finally(function () { if (current(token)) { signingOut = false; draw(); } }).catch(function () {});
        var result = await bounded(operation);
        if (result && result.error) throw new Error('signout');
      } catch (_) { if (current(token)) status('auth-status', 'This page has cleared your details. Account sign-out could not be confirmed; close this page on a shared device.', true); }
    }
    function payload(mode) {
      var get = function (key) { return field(mode.form, key).value.trim(); };
      if (!mode.form.reportValidity()) return null;
      if (mode.kind === 'prayer') return get('request_text') ? { display_name: get('display_name'), request_text: get('request_text'), contact_text: get('contact_text') } : null;
      var preferred = get('preferred_contact'), visit = get('visit_status'), date = get('first_visit_on');
      if (!get('first_name') || !field(mode.form, 'contact_permission').checked || !['email','phone','text'].includes(preferred) || (preferred !== 'email' && !get('phone')) || !['not_yet','first_visit','returning'].includes(visit)) return null;
      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T12:00:00Z')) || new Date(date + 'T12:00:00Z').toISOString().slice(0,10) !== date)) return null;
      if (visit === 'not_yet' && date) { status('guest-status', 'Leave the first-visit date blank if you have not visited yet.', true); return null; }
      try { return Object.assign({ first_name: get('first_name'), last_name: get('last_name'), phone: get('phone'), preferred_contact: preferred, contact_permission: true, sunday_school: get('sunday_school'), visit_status: visit, first_visit_on: date || null }, extraPayload()); }
      catch (_) { status('guest-status', 'Check the family names, relationships, and birthdays. Birthdays cannot be in the future.', true); return null; }
    }
    async function dispatch(token, mode, saved, serial) {
      var profileChecked=mode.kind!=='guest';
      try {
        if (!await verify(token, user && user.id)) return;
        if(mode.kind==='guest'){
          var profileResult=await bounded(client.rpc('get_my_app_connection'));
          if(!current(token)||mode.serial!==serial||mode.saved!==saved)return;
          var currentProfile=profileResult&&!profileResult.error&&row(profileResult.data);
          if(!currentProfile||currentProfile.email!==user.email)throw new Error('current-profile');
          profileChecked=true;
          if(currentProfile.guest_removed===true){guestRemoved=true;status('guest-status','The original submission was received, but the office has since removed this guest registration. Ask the office to restore it if needed. Your login and prayer requests still work.',true);draw();return;}
        }
        var result = await bounded(client.functions.invoke('welcome-dispatch', { body: {} }));
        if (!current(token) || mode.serial !== serial || mode.saved !== saved) return;
        if (mode.kind === 'prayer') return;
        if (!result || result.error || !result.data || result.data.status !== 'processed' || !['sent','queued','needs_attention'].every(function (key) { return Number.isSafeInteger(result.data[key]) && result.data[key] >= 0; })) throw new Error('welcome');
        status('guest-status', 'Registration saved. Your details are in the private guest register. The welcome email was requested; delivery is not confirmed.');
      } catch (_) { if (mode.kind === 'guest' && current(token) && mode.serial === serial && mode.saved === saved) {if(!profileChecked)loaded=false;status('guest-status', 'Your registration receipt is saved. Current follow-up or welcome email status could not be confirmed. Reload your saved registration before making another submission.');draw();} }
    }
    async function submit(mode) {
      if (!client || destroyed || mode.busy) return;
      if (mode.kind === 'guest' && preferenceBlocked()) return;
      if (!user) {
        if (authBusy || authPending || authUncertain) return;
        var captured = mode.attempt ? mode.attempt.payload : payload(mode); if (!captured) return;
        if (pendingSubmit && pendingSubmit.mode !== mode) cancelIntent(false);
        if (!mode.attempt) mode.attempt = { id: win.crypto.randomUUID(), payload: captured, owner: null, started: false, preference: mode.kind === 'guest' ? guestPreference() : null };
        pendingSubmit = { mode: mode, attempt: mode.attempt }; mode.dirty = true;
        draw(); openDialog(); status('auth-status', 'Create an account or sign in to send this ' + (mode.kind === 'guest' ? 'registration' : 'prayer request') + '.'); return;
      }
      if (mode.kind === 'guest' && (!loaded || reading || guestRemoved)) return;
      var body = mode.attempt ? mode.attempt.payload : payload(mode); if (!body) return;
      var token = epoch, owner = user.id, serial = ++mode.serial;
      if (!mode.attempt) mode.attempt = { id: win.crypto.randomUUID(), payload: body, owner: owner, started: false, preference: mode.kind === 'guest' ? guestPreference() : null };
      var attempt = mode.attempt; if (attempt.owner === null && !attempt.started) attempt.owner = owner;
      if (attempt.preference && attempt.preference.version === null) {
        if (!preferences.loaded) return;
        if (!attempt.preference.touched) attempt.preference.weekly = preferences.value.weekly_email;
        attempt.preference.version = preferences.value.preference_version;
      }
      if (pendingSubmit && pendingSubmit.attempt === attempt) pendingSubmit = null;
      if (attempt.owner !== owner) { loseIdentity(); return; }
      mode.busy = true; mode.dirty = true; mode.saved = null; status(mode.kind + '-status', 'Sending securely to the church office…'); draw();
      var refreshPreferences = false, refreshProfile = false;
      try {
        if (!await verify(token, owner)) return;
        var parameters = { p_request_id: attempt.id }; parameters[mode.kind === 'guest' ? 'p_profile' : 'p_request'] = attempt.payload;
        if (attempt.preference) { parameters.p_weekly_email = attempt.preference.weekly; parameters.p_preference_version = attempt.preference.version; }
        attempt.started = true; draw();
        var result = await bounded(client.rpc(mode.kind === 'guest' ? (attempt.preference ? 'register_app_guest_with_preferences' : 'register_app_guest') : 'submit_app_prayer', parameters));
        if (!current(token) || serial !== mode.serial || mode.attempt !== attempt) return;
        if (mode.kind==='guest' && result && result.error && result.error.code==='55000' && result.error.message==='GUEST_REMOVED') {
          guestRemoved=true;mode.attempt=null;status('guest-status','The office removed this guest registration. Ask the office to restore it before saving another update. Your login and prayer requests still work.',true);return;
        }
        if (attempt.preference && communicationConflict(result && result.error)) {
          mode.attempt = null; preferences.loaded = false; loaded = false; refreshPreferences = true; refreshProfile = true;
          status('guest-status', 'This save did not change your records. Your saved registration or email choice changed elsewhere. Your form is kept here; review it before saving again.', true); return;
        }
        if (attempt.preference && communicationRateLimit(result && result.error)) {
          mode.attempt = null; preferences.loaded = false; refreshPreferences = true;
          status('guest-status', 'This save did not change your records. Wait before turning weekly emails on again, or uncheck weekly updates and save your registration now.', true); return;
        }
        var saved = result && !result.error && receipt(result.data, mode.kind); if (!saved) throw new Error('receipt');
        if (attempt.preference) {
          var choice = preferenceValue(saved.communication_preferences);
          if (!choice || choice.preference_version !== attempt.preference.version + 1 || choice.weekly_email !== attempt.preference.weekly || !choice.email_matches) throw new Error('receipt');
          preferences.loaded = false; preferences.guestTouched = false; refreshPreferences = true;
        }
        mode.saved = saved; mode.attempt = null; mode.dirty = false;
        if (mode.kind === 'guest') {
          field(mode.form, 'contact_permission').checked = false; mode.extraTouched.clear();
          status('guest-status', 'Registration receipt confirmed. Checking the current guest registration and welcome email status. This does not make you a church member.');
          // A registration receipt is durable even if this separate mail request fails.
          void dispatch(token, mode, saved, serial);
        } else {
          mode.form.reset(); status('prayer-status', 'Prayer request received by the church office. It is saved privately for our church team. Your prayer text is not published or emailed.');
          void dispatch(token, mode, saved, serial);
        }
      } catch (_) { if (current(token) && serial === mode.serial) status(mode.kind + '-status', 'We could not confirm a receipt. Your form is kept here. Use “Check and retry” to resend the same request safely; do not start a second submission.', true); }
      finally { if (current(token) && serial === mode.serial) { mode.busy = false; draw(); if (refreshPreferences) await Promise.all([readPreferences(token), refreshProfile ? readProfile(token) : Promise.resolve()]); } }
    }
    Object.values(modes).forEach(function (mode) {
      mode.form.addEventListener('submit', function (event) { event.preventDefault(); void submit(mode); });
      mode.form.addEventListener('input', function (event) { if (mode.kind === 'guest' && !mode.attempt) { var key = event.target.closest('[data-family-row]') ? 'family_members' : event.target.name; if (extraKeys.includes(key)) mode.extraTouched.add(key); if (key === 'weekly_email') preferences.guestTouched = true; } if (!mode.attempt) { mode.dirty = true; mode.saved = null; mode.serial++; } draw(); });
      mode.form.addEventListener('change', function (event) { if (mode.kind === 'guest' && !mode.attempt) { var key = event.target.closest('[data-family-row]') ? 'family_members' : event.target.name; if (extraKeys.includes(key)) mode.extraTouched.add(key); if (key === 'weekly_email') preferences.guestTouched = true; } if (!mode.attempt) { mode.dirty = true; mode.saved = null; } field(modes.guest.form, 'phone').required = field(modes.guest.form, 'preferred_contact').value !== 'email'; draw(); });
      el(mode.kind + '-new').addEventListener('click', function () { if (!mode.busy && !mode.attempt) { mode.form.reset(); if (mode.kind === 'guest') { resetExtras(); preferences.guestTouched = false; if (preferences.loaded) field(mode.form,'weekly_email').checked = preferences.value.weekly_email; } mode.saved = null; mode.dirty = false; mode.serial++; status(mode.kind + '-status', ''); draw(); } });
    });
    preferenceForm.addEventListener('input', function () { if (!preferences.loaded || preferences.busy || preferences.attempt || modes.guest.busy || modes.guest.attempt) return; preferences.dirty = field(preferenceForm,'weekly_email').checked !== preferences.value.weekly_email; status('preferences-status', preferences.dirty ? 'Your email choice has not been saved yet.' : ''); draw(); });
    preferenceForm.addEventListener('submit', function (event) { event.preventDefault(); void savePreference(); });
    el('communication-retry').addEventListener('click', async function () { if (!client || destroyed || el('communication-retry').disabled) return; if (preferences.capability !== 'available') await readCapabilities(epoch); if (user) await readPreferences(epoch); });
    el('family-add').addEventListener('click', function () { if (!client || modes.guest.attempt || modes.guest.busy || reading) return; addFamily(null, true); });
    doc.querySelectorAll('[data-connection-account]').forEach(function (button) { button.addEventListener('click', openDialog); });
    el('close').addEventListener('click', function () { cancelIntent(false); closeDialog(); });
    dialog.addEventListener('cancel', function () { cancelIntent(false); });
    el('signout').addEventListener('click', function () { void signout(); });
    el('retry-profile').addEventListener('click', function () { void readProfile(epoch); });
    el('reset-open').addEventListener('click', function () { el('reset-form').hidden = !el('reset-form').hidden; });
    el('reset-form').addEventListener('submit', async function (event) {
      event.preventDefault(); if (!client || destroyed || resetBusy || !el('reset-form').reportValidity()) return;
      var token = epoch; resetBusy = true; draw();
      try { await bounded(client.auth.resetPasswordForEmail(el('reset-email').value.trim(), {redirectTo:config.redirect})); } catch (_) {}
      if (!current(token)) return;
      el('reset-email').value = ''; resetBusy = false;
      status('reset-status', 'If a reset link can be sent for that address, check your inbox. If none arrives, try again later or ask the church office for help.'); draw();
    });
    el('auth-mode').addEventListener('change', function () { el('password').autocomplete = el('auth-mode').value === 'signup' ? 'new-password' : 'current-password'; el('password').minLength = el('auth-mode').value === 'signup' ? 12 : 1; draw(); });
    authForm.addEventListener('submit', async function (event) {
      event.preventDefault(); if (!client || destroyed || authBusy || authUncertain || signingOut || authPending || !authForm.reportValidity()) return;
      if (el('auth-mode').value === 'signup' && el('password').value.length < 12) { status('auth-status', 'Choose a password with at least 12 characters.', true); return; }
      authBusy = true; authPending = true; var token = epoch, intent = pendingSubmit; store.choose(el('remember').checked); draw();
      var credentials = { email: el('email').value.trim(), password: el('password').value };
      var operation;
      try {
        operation = Promise.resolve(el('auth-mode').value === 'signup' ? client.auth.signUp(credentials) : client.auth.signInWithPassword(credentials));
        operation.finally(function () { authPending = false; if (!destroyed) draw(); }).catch(function () {});
        var result = await bounded(operation);
        if (!current(token)) return;
        if (!result || result.error || !result.data || !result.data.session) { status('auth-status', 'We could not sign you in. Check your email and password, or contact the office if creating an account is unavailable. Your form has not been sent.', true); return; }
        await adopt(result.data.session, true);
        // Resume only the exact Send intent that this successful password action began.
        // Auth events, late/uncertain responses and later profile retries never trigger it.
        if (current(token) && user && intent && pendingSubmit === intent && intent.mode.attempt === intent.attempt) {
          pendingSubmit = null; intent.attempt.owner = user.id;
          if (intent.mode.kind !== 'guest' || (loaded && !preferenceBlocked())) await submit(intent.mode);
          else status('guest-status', 'You’re signed in. Load your saved registration and email choice, then select Save my registration to send these details.', true);
        }
      } catch (_) { if (current(token)) { cancelIntent(true); authUncertain = true; status('auth-status', 'The account response could not be confirmed. When the request finishes, use Check sign-in before trying again. Your form has not been sent.', true); } }
      finally { credentials.password = ''; if (current(token)) { el('password').value = ''; authBusy = false; draw(); } }
    });
    el('auth-check').addEventListener('click', async function () {
      if (!client || authPending || authBusy || !authUncertain) return;
      authBusy = true; var token = epoch; draw();
      try { var result = await bounded(client.auth.getSession()); if (!current(token)) return; if (result.error) throw new Error('session'); authUncertain = false; if (result.data.session) await adopt(result.data.session, true); else status('auth-status', 'No sign-in was confirmed. You can try your email and password again.', true); }
      catch (_) { if (current(token)) status('auth-status', 'Sign-in is still unavailable. Your form has not been sent.', true); }
      finally { if (current(token)) { authBusy = false; draw(); } }
    });
    function onAuth(event, session) {
      if (destroyed || signingOut || event === 'INITIAL_SESSION') return;
      if (event === 'SIGNED_OUT' || !session) { epoch++; store.clear(); clearPrivate(); return; }
      if (user && (!session.user || session.user.id !== user.id || session.user.email !== user.email)) { epoch++; clearPrivate(); }
      if (authBusy || authUncertain || authPending || (user && session.user.id === user.id)) return;
      var token = epoch; win.setTimeout(function () { if (current(token)) void adopt(session, !user); }, 0);
    }
    function destroy() { if (destroyed) return; epoch++; clearPrivate(); destroyed = true; win.removeEventListener('beforeunload', beforeUnload); if (subscription) subscription.unsubscribe(); if (client && client.auth.stopAutoRefresh) client.auth.stopAutoRefresh(); }
    win.addEventListener('pagehide', destroy);
    win.addEventListener('pageshow', function (event) { if (event.persisted) win.location.reload(); });
    draw();
    var ready = (async function () {
      if (!config) { status('availability', 'Online registration and prayer submission are not connected yet. Please contact the office or speak with us at church. Nothing entered here will be sent.', true); return; }
      try {
        var create = options.createClient || await loadSdk(doc); if (destroyed) return;
        client = create(config.url, config.key, { auth: { storageKey: SESSION_KEY, storage: store.storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'implicit' } });
        subscription = client.auth.onAuthStateChange(onAuth).data.subscription;
        status('availability', ''); draw();
        await readCapabilities(epoch); if (destroyed) return;
        if (user && preferences.capability === 'available' && !preferences.loaded && !preferences.reading) await readPreferences(epoch);
        var token = epoch, result = await bounded(client.auth.getSession()); if (!current(token)) return;
        if (result.error) throw new Error('session'); if (result.data.session) await adopt(result.data.session, true); else onboarding(true);
      } catch (_) { if (!destroyed) { status('availability', 'Account services could not be reached. Your information has not been sent. Please reload to try again.', true); client = null; draw(); } }
    })();
    return { ready: ready, destroy: destroy };
  }
  return { initialize: initialize, settings: settings, consumeRedirect: consumeRedirect, sessionStore: sessionStore };
});
