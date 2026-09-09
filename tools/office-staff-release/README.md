# Staff-only release: proposed public service-worker boundary

Review artifact only. `sw.js` here is based on **app main `3d001e53145cd04d0d2f249bd2f88f78570edbbd`**, not the newer full-app candidate worker. The public root `sw.js`, homepage, events, manifest, configuration and backend have not been edited by this task. No branch, commit, hosting or deployment action was performed.

Base worker SHA256: `b3a1633b7ad7eb340c2c1c87a10adb8614745870b16543e99167509b7eef0b6d`
Proposed worker SHA256: `ee93b7a440e032bc356bee24f160b94704a63fbb87f29cd95c1f55240ba429b6`

## Proposed change

The 11 public shell URLs from main remain exactly the same. The cache moves from `creek-v3` to `creek-v4-office-safe`; activation retires only known public versions 1–3 and claims clients. Reads address only the new cache, so even a late old-worker request that recreates `creek-v3` cannot make its contaminated home entry a fallback for the new worker.

`/admin`, `/admin/…`, their encoded-path equivalents, all cross-origin requests and all non-GET requests bypass this worker entirely. That includes the backend, SDK CDN and external fonts. Other pages and query-bearing navigation do not receive the public-home fallback. Only a successful, nonredirected HTML response at the exact same-origin `/` or `/index.html` URL may update the cached public home. The public events feed remains network-first and same-origin assets remain cache-first. HTTP errors and cache write failures do not replace successful network responses; if CacheStorage cannot be opened, the public request falls back directly to the network.

Installation uses native `Cache.addAll` with worker-created Requests, `cache: reload`, `redirect: error` and omitted credentials. It never accepts page content/messages or copies an old cache. The Service Worker specification makes `Cache.addAll` requests initiated in the worker bypass service-worker interception; this prevents an old controlled page/worker from seeding the new shell. `reload` separately bypasses the browser HTTP cache, and unexpected redirects fail installation instead of changing shell destinations. [Service Worker Cache.addAll algorithm](https://w3c.github.io/ServiceWorker/#cache-addAll), [Request cache modes](https://developer.mozilla.org/en-US/docs/Web/API/Request/cache).

## Verification

**15 isolated Node tests passed**, with no network or browser/account operations. They exercise actual proposed-worker event handlers against simulated CacheStorage/network APIs: exact main-shell installation and request options, failed installation, old-cache retirement and late resurrection, private/cross-origin bypasses, successful/failed/redirected/non-HTML navigation, events freshness, asset-query spoofing, cache quota errors and unavailable CacheStorage. `node --check` also passed.

```sh
node --test tools/office-staff-release/worker.test.mjs
node --check tools/office-staff-release/sw.js
```

The tests model browser APIs; they do not claim an actual installed-client upgrade or native network/cache behavior has been exercised. Machine-readable hashes and scope are in `review.json`.

## Upgrade boundary and release handoff

Publishing this proposal does not retroactively change an old active worker. Until the browser fetches the update, finishes installation and activates it, its old worker can still handle an initial office navigation. `skipWaiting` runs only after successful shell installation; an offline/failed installation leaves the old worker active. `clients.claim` changes control after activation, but does not replace HTML already rendered by an earlier navigation. The new worker cannot repair a document already shown by the old one. [skipWaiting behavior](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/skipWaiting).

Before real staff use, verify the existing-client upgrade on the reviewed deployment: begin with main's old worker controlling a page, install/activate the replacement, confirm control has changed, then reload/navigate to the office and recovery route. Confirm those requests bypass the worker, the public home remains correct online/offline, the retired cache is not used, and private backend responses do not enter CacheStorage. An initial old-controlled navigation is a known transition risk; deliver staff invitations only after the intended staff browser's update is confirmed. Actual hosted/device upgrade remains a release acceptance check.

The parent may assemble a private review overlay containing current main's 20 files with only this worker replacement, plus the 25 new office/font/license files. Preserve the existing CNAME and branding routes. This proposal does not authorize publishing the full 49-file candidate package or activating accounts. No deployment has occurred.
