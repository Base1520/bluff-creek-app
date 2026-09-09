/* Public app status only: never reload a window or read, store or clear a draft. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CreekAppStatus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function initialize(doc) {
    var win = doc.defaultView, box = doc.getElementById('appStatus');
    if (!box || box.dataset.statusReady) return;
    box.dataset.statusReady = 'true';
    var nav = win.navigator, update = doc.getElementById('appUpdate');
    var offline = doc.getElementById('appOffline'), saved = doc.getElementById('appSaveStatus');
    var waiting = false, saveFailed = false;
    function message(node, text) {
      if (node.textContent !== text) node.textContent = text;
      node.hidden = !text;
    }
    function render() {
      message(offline, nav.onLine === false ? 'You’re offline. Previously saved pages may still be available. Music, videos, linked resources and current updates need a connection. Keep any unsent entries open.' : '');
      message(update, waiting ? 'An app update is ready. Finish with any unsent entries first, then close all Creek app windows and reopen the app.' : '');
      message(saved, saveFailed && nav.onLine !== false ? 'We couldn’t confirm offline access on this visit. You can keep using the app while connected.' : '');
      box.hidden = offline.hidden && update.hidden && saved.hidden;
    }
    win.addEventListener('online', render);
    win.addEventListener('offline', render);
    doc.addEventListener('visibilitychange', render);
    render();
    if (!nav.serviceWorker) return;
    function register() {
      Promise.resolve().then(function () {
        return nav.serviceWorker.register('sw.js', { updateViaCache:'none' });
      }).then(function (registration) {
        var observed = [];
        function observe(worker) {
          if (!worker || observed.indexOf(worker) !== -1) return;
          observed.push(worker);
          worker.addEventListener('statechange', check);
        }
        function check() {
          observe(registration.installing);
          observe(registration.waiting);
          // Only an installed replacement waiting behind an existing app is ready.
          waiting = !!(nav.serviceWorker.controller && observed.some(function (worker) { return worker.state === 'installed'; }));
          render();
        }
        registration.addEventListener('updatefound', check);
        check();
      }).catch(function () { saveFailed = true; render(); });
    }
    if (doc.readyState === 'complete') register();
    else win.addEventListener('load', register, { once:true });
  }
  return { initialize:initialize };
});
