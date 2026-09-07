# Grow: series, music and reading

Grow is a public app screen at `#grow`, with an entry on Home and in More. It follows the original Homestead kit. The bottom navigation remains five items: Home, Prayer, Calendar, Grow, More. Giving remains on the Home quick-action row and in More; its destination is unchanged.

## Current content

The user confirmed Habakkuk for the coming months, except September 13, 2026. The September 6 passage, Habakkuk 1:2–4, is supported by dated church sermon metadata; this is not proof of a recording or its availability. No future weekly passage, exact series end date, or September 13 topic has been invented.

The guide covers historical setting, the movement of the book, themes, and reading questions. Historical dating is explicitly approximate. It contains original summaries and references, with no copied private sermon prose or new personal records. The guide is reviewable church content, not attributed as Pastor Cole's verbatim writing.

Sources consulted September 6, 2026:

- [Habakkuk 1–3](https://www.biblegateway.com/passage/?search=Habakkuk+1-3&version=ESV): biblical passage summaries and references.
- [ESV Global Study Bible introduction](https://www.esv.org/resources/esv-global-study-bible/introduction-to-habakkuk/): late seventh-century framing, uncertainty, themes and New Testament connections.
- [BibleProject's Habakkuk guide](https://bibleproject.com/guides/book-of-habakkuk/): literary movement and the prophet's dialogue with God.
- [Spotify's official embed instructions](https://developer.spotify.com/documentation/embeds/tutorials/creating-an-embed): playlist embedding. No Web API, Spotify account access or app credentials are required by this implementation.

## Change the selections

Edit the public `js/grow-content.js` file on a feature branch, preview and review before releasing. This is currently a file-based workflow; Creek Office is not connected to a content editor. Do not put private sermon notes, source-calendar addresses, credentials or member records in this file.

- `updated`: the church review date.
- `series.title`, `subtitle`, `introduction`: short public copy.
- `series.currentPassage`: `{ reference: 'Habakkuk 1:2–4', date: '2026-09-06' }`, or `null` when no passage is confirmed. This remains a dated latest passage and does not claim to be the next Sunday's text.
- `series.pause`: an absolute `YYYY-MM-DD` date, a title that includes that date, and public description, or `null`. The notice appears through that day in America/Chicago and then hides. Long-open sessions recheck on visibility changes and every minute. Set the actual September 13 topic only after Cole confirms it.
- `spotify.playlistUrl`: the full approved `https://open.spotify.com/playlist/…` share link. Localized `intl-xx` links work; tracking/query fragments are removed. Shortened Spotify links and non-playlist entities are not accepted. The blank current value intentionally displays a coming-soon state.
- `books`: Cole's approved recommendations only. Each item needs `approved: true`, `title`, and `author`. Optional `note` is a short approved explanation; optional `url` is the publisher's HTTPS page. Unapproved entries never render. The current list is empty because Cole has not yet supplied titles. No sample books, invented endorsements, affiliate tags or purchase transactions are included.

For the next series, also replace the static context/chapters/reflections/source links in `index.html`; they are specifically about Habakkuk. Do not change only the config title and accidentally leave Habakkuk's guide beneath another book.

## Playback and offline behavior

The app makes no Spotify request until a visitor clicks **Load Spotify player** or follows **Open in Spotify**. The player is built from the validated playlist ID, with a descriptive title, no autoplay request and a persistent external fallback. It is never represented as successfully playing merely because its frame loaded. **Close player** removes the frame and restores focus. Spotify controls playback, account/region availability and any previews. Actual playback cannot be verified until the approved public playlist is supplied.

The text guide, CSS and both public Grow scripts join the versioned `creek-v6` service-worker shell (19 assets). Music and linked books/Bible resources need internet; no audio or third-party content is cached. Existing private/admin route exclusions remain.

## Verification

Run `node --test tests/*.test.cjs`. Grow tests cover playlist URL restrictions/tracking removal, safe book links and the September 13 expiry at Central midnight. Browser review should cover Home/Grow/More navigation, deep links/history/heading focus, 1440/375/320 widths, expanded context, empty content, hostile text and unapproved-book fixtures, click-only Spotify loading/removal and installed offline access. Fixtures must not contact Spotify or play audio. No backend, account, invitation or deployment action is part of these checks.
