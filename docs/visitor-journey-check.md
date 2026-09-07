# Visitor destinations — September 7, 2026

Read-only destination audit of the public website candidate (`work/homestead-editorial`) and app candidate (`work/admin-portal`). No messages, calls, donations, sign-ins, account changes, or deployment were performed. Runtime changes correct the iPad install guidance and align the telephone URI with the website’s global number. Public cache advances to creek-v11 through its ordinary lifecycle.

## Fixed in the candidate

`index.html:633` recognized iPhone/iPad/iPod user-agent tokens but missed iPadOS Safari using its desktop Mac identity. The detection now also recognizes a Macintosh user agent with more than one touch point. `index.html:648` no longer says the Share button is “below,” because its position varies. The existing standalone guard is preserved.

WebKit documents iPad Safari's desktop user-agent behavior and recommends avoiding user-agent assumptions. The additional detection here is a narrow compatibility heuristic for instructions; it does not establish actual installability. [WebKit: Safari 13](https://webkit.org/blog/9674/new-webkit-features-in-safari-13/). The browser installation event is not universally available. [MDN: beforeinstallprompt](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeinstallprompt_event)

Synthetic verification evaluated the actual detector extracted from `index.html`: iPhone, traditional iPad, and desktop-identifying touch iPad returned true; desktop Mac, Android, and touch Windows returned false. Six scenarios passed. Position-independent wording and the standalone guard were also checked. Actual iPhone/iPad installation remains unverified.

## Telephone link corrected

`index.html:615` derives the app's telephone URI by stripping punctuation from the display number, producing a ten-digit local number without a country prefix or phone context. The website's `contact.html:137` and footer use the corresponding global `+1` form. The app now adds the US country prefix to the configured ten-digit number (and normalizes a leading 1 without a plus). Displayed contact text and destination remain unchanged. This matters for international dial plans and strict URI consumers. [RFC 3966, §5.1](https://www.rfc-editor.org/rfc/rfc3966) requires global notation when the number has a global representation. No phone call was made. The telephone normalization was separately checked against the website’s existing tel destination; no call was placed.

## Source consistency

| Journey | Website candidate | App candidate | Finding |
| --- | --- | --- | --- |
| Visit / directions | `visit.html:135`, `visit.html:174`, `contact.html:136` | `index.html:492` | Same approved street-address query at Apple Maps. |
| Watch | `watch.html:133`, `watch.html:136`; optional `js/watch.js` | `index.html:532`, `index.html:608` | Same YouTube channel/live route. Website additionally offers a plain channel link. No stream availability is inferred. |
| Giving | `give.html:134` | `index.html:530`, `index.html:612` | Same Stripe payment-link destination. App recurring-giving control stays absent because its URL is unset. |
| Contact email | `contact.html:137`, `contact.html:167` | `index.html:528`, `index.html:621`; `js/app-forms.js` | Same office email. Forms describe preparing a draft and require the visitor to send it in their mail app. |
| Open / install app | Shared website footer, e.g. `visit.html:188` | `manifest.webmanifest`; `index.html:631`–`648` | Website links to the public app origin; app manifest uses a relative start URL/scope and standalone display. |

## Public endpoint checks

Independent unauthenticated HTTP GETs returned 200 for the public [website](https://www.bluffcreekbaptistchurch.org/), [app](https://app.bluffcreekbaptistchurch.org/), shared [Stripe checkout](https://buy.stripe.com/9B600j6Q68IFgK8h13bo400), [YouTube live route](https://www.youtube.com/channel/UC75FUMm1TckzTRpfYHd_ILQ/live), and [Apple Maps address search](https://maps.apple.com/?q=1706+Highway+63,+Clinton,+LA+70722). Maps redirects to its search page with the same address query; the final pin or a navigation route was not verified.

The public app's manifest, service worker, start page, and 192/512-pixel icons also returned 200 with appropriate manifest/JavaScript/HTML/PNG content types. Its publicly served service-worker cache is still `creek-v3`; that is a production observation, not evidence that the current candidate has been released.

HTTP reachability is not end-to-end success. The checkout response's title is Stripe Checkout, but merchant identity, accepted wallets, receipt delivery, and a donation were not verified. The YouTube route's 200 does not prove a church video, live stream, or audible playback. This audit's browser tool had no available browser, so these are endpoint/source checks rather than browser-session checks.

## Remaining real-device checks

Open the directions result and confirm the church pin; open a contact draft and confirm recipient/content without claiming delivery; check telephone handoff on the actual phone; install/reopen on iPhone and Android (and review the corrected iPad hint); inspect the giving checkout's church identity and wallet choices; verify the actual YouTube stream/video and audio. A financial transaction or sending a message is a separate user-authorized action, not part of this audit.

Use the [phone rehearsal worksheet](phone-rehearsal.md) for the device checks, including audible Spotify playback and its app/browser fallback. Its actual results remain pending; a worksheet is not a completed rehearsal.
