# Grow: series, music and reading

Grow is a public app screen at `#grow`, with an entry on Home and in More. It follows the original Homestead kit. The bottom navigation remains five items: Home, Prayer, Calendar, Grow, More. Giving remains on the Home quick-action row and in More; its destination is unchanged.

## Current content

On September 7 the pastor confirmed: **Sunday, September 13: Colossians 3 again; Sunday, September 20: Habakkuk 1:2–4.** The app displays September 20 as a scheduled upcoming series passage, not an already-preached message. The September 13 exception has its confirmed topic. The earlier claim of a September 6 Habakkuk passage is cleared (`currentPassage: null`); no historical sermon date has been inferred. The Habakkuk introduction and historical guide remain available.

The guide covers historical setting, the movement of the book, themes, and reading questions. Historical dating is explicitly approximate. It contains original summaries and references, with no copied private sermon prose or new personal records. The guide is reviewable church content, not attributed as Pastor Cole's verbatim writing.

Sources consulted September 6, 2026:

- [Habakkuk 1–3](https://www.biblegateway.com/passage/?search=Habakkuk+1-3&version=ESV): biblical passage summaries and references.
- [ESV Global Study Bible introduction](https://www.esv.org/resources/esv-global-study-bible/introduction-to-habakkuk/): late seventh-century framing, uncertainty, themes and New Testament connections.
- [BibleProject's Habakkuk guide](https://bibleproject.com/guides/book-of-habakkuk/): literary movement and the prophet's dialogue with God.
- [Spotify's official embed instructions](https://developer.spotify.com/documentation/embeds/tutorials/creating-an-embed): playlist embedding. No Web API, Spotify account access or app credentials are required by this implementation.

## Music direction

The pastor confirmed a Scripture-rich hymn/psalm direction and exclusion of Bethel, Hillsong and Elevation, including composition and recording ties. Brandon Lake is omitted from the starter. Preferred artists are evaluated song by song; covers do not erase credits. See [music selection](music-selection.md) and the researched starter queue. [Songs @ the Creek](https://open.spotify.com/playlist/58ciuGp95u3Sq1bWVjSu13) is saved publicly under **Bluff Creek Baptist Church**: 16 songs, displayed duration 1 hr 14 min. The candidate uses its real URL. Saved order, exact track/album links and persistence after reload were verified in Spotify. The playback timer advanced and was paused; audible output and real-phone listening remain to be checked. Books remain separately pending.

## Change the selections

Edit the public `js/grow-content.js` file on a feature branch, preview and review before releasing. This is currently a file-based workflow; Creek Office is not connected to a content editor. Do not put private sermon notes, source-calendar addresses, credentials or member records in this file.

- `updated`: the church review date.
- `series.title`, `subtitle`, `introduction`: short public copy.
- `series.currentPassage`: `{ reference: 'Habakkuk 1:2–4', date: '2026-09-06' }`, or `null` when no passage is confirmed. This remains a dated latest passage and does not claim to be the next Sunday's text.
- `series.nextPassage`: a confirmed upcoming passage/date, or `null`. It is labeled scheduled, hides after its date in Central time, and is never automatically promoted to preached history. After the service, explicitly confirm a `currentPassage` and set the next planned text.
- `series.pause`: an absolute `YYYY-MM-DD` date, a title that includes that date, and public description, or `null`. When confirmed and configured, the notice appears through that day in America/Chicago and then hides. Long-open sessions recheck on visibility changes and every minute. September 13 Colossians 3 is confirmed; change the exception only after a new pastoral instruction.
- `spotify.playlistUrl`: the full approved `https://open.spotify.com/playlist/…` share link. Localized `intl-xx` links work; tracking/query fragments are removed. Shortened Spotify links and non-playlist entities are not accepted. The current value points to the saved church playlist. An intentionally blank value displays the preparation state.
- `books`: Cole's approved recommendations only. Each item needs `approved: true`, `title`, and `author`. Optional `note` is a short approved explanation; optional `url` is the publisher's HTTPS page. Unapproved entries never render. The current list is empty while Cole reviews the 21-title [approval checklist](book-approval.md) and [source record](book-candidates.json). His author suggestions identify candidates; they do not approve individual titles. All candidate approval fields start false. Returned checkbox selections and notes must be reconciled by stable ID before adding approved entries here. No sample books, invented endorsements, affiliate tags or purchase transactions are included.

For the next series, also replace the static context/chapters/reflections/source links in `index.html`; they are specifically about Habakkuk. Do not change only the config title and accidentally leave Habakkuk's guide beneath another book.

## Amazon links and affiliate preparation

The separate browser approval review now gives every candidate an Amazon option: 12 verified product destinations and 9 labeled searches. Publisher/author links remain intact; all links are untagged and all titles remain pending approval. The user authorized starting a church-owned Amazon Associates application. Signup is in progress; no issued tracking ID or completed enrollment has been verified. See [Amazon setup and link rules](amazon-book-links.md).

Do not copy Amazon destinations into the installed PWA yet. Amazon’s published application requirements leave this PWA’s eligibility unresolved, including untagged links while participating in Associates. Confirm that classification and any app-to-website route with Amazon before activation. Approved books may still use their publisher/author URLs.

## Playback and offline behavior

The app makes no Spotify request until a visitor clicks **Load Spotify player** or follows **Open in Spotify**. The player is built from the validated playlist ID, with a descriptive title, no autoplay request and a persistent external fallback. It is never represented as successfully playing merely because its frame loaded. **Close player** removes the frame and restores focus. Spotify controls playback, account/region availability and any previews. The real playlist title rendered in the local embed. Spotify’s full player entered playing state with an advancing timer and was paused afterward; this does not establish audible output, full-track access or actual-phone playback. Keep that listening rehearsal on the launch checklist.

The text guide, CSS and both public Grow scripts join the versioned `creek-v9` service-worker shell (19 assets). Music and linked books/Bible resources need internet; no audio or third-party content is cached. Existing private/admin route exclusions remain.

## Verification

Run `node --test tests/*.test.cjs`. Grow tests cover playlist URL restrictions/tracking removal, safe book links and the September 13 expiry at Central midnight. Browser review should cover Home/Grow/More navigation, deep links/history/heading focus, 1440/375/320 widths, expanded context, empty content, hostile text and unapproved-book fixtures, click-only Spotify loading/removal and installed offline access. Fixtures must not contact Spotify or play audio. Local automated tests make no backend, account, invitation or deployment changes. The separately authorized church-account playlist save is recorded in the music selection log.
