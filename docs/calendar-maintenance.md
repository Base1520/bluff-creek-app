# The church calendar

The church’s iCloud calendar is the source of truth for public event dates. The owner supplies a view-only publication and separately invites approved editors through Apple Calendar sharing. Creek Office accounts do not grant Apple permissions. The user confirmed the iCloud times on September 6, 2026: **Yoga Tuesday/Thursday 3:45–4:30 p.m.; WMU third Tuesday at 5 p.m.**

## What visitors see

The app and website consume identical curated JSON. Repeating events, exceptions, moved dates, cancellations and all-day spans come from iCloud; the former Google CSV no longer overlays that source. Upcoming lists use America/Chicago and retain an ongoing event until its end. A multi-day all-day event keeps its exclusive end date and displays the final included day.

The current branch includes a **90-day snapshot**, its matching calendar download, and the date it was imported. It does not claim to refresh itself. The embedded fallback, app `events.json`, website `data/events-fallback.json`, and both `calendar.ics` files are synchronized. Stale/offline status is visible; expired dates are not restored from the former recurring seed. A newer embedded snapshot also outranks an older cached response.

The original public iCloud response does not provide browser CORS headers and contains personal reminders/contact metadata. Its raw URL and contents are intentionally absent from public code and exports. The curated converter uses reviewed exact source titles, safe public labels and approved church-place matches. Unknown titles, personal reminders, private/confidential events, descriptions, organizer/attendees, contacts, raw identifiers, locations, URLs and attachments are not copied. An unreviewed location says to check with the church. Public ICS identifiers are generated from the public occurrence fields, not the original IDs.

## Adding or editing an event

1. The calendar owner invites each approved editor in Apple Calendar/iCloud and enables editing. Use Apple Calendar on iPhone, or iCloud Calendar on a tablet/computer. See [Apple’s sharing guide](https://support.apple.com/guide/icloud/share-a-calendar-mm6b1a9479/icloud).
2. Make the change in the church’s iCloud calendar. Update or cancel the actual occurrence/series; do not create a duplicate calendar in Creek Office.
3. Public community requests can still use the existing Google Form. Staff review those requests and enter approved changes in iCloud. Marking the former sheet’s Status as Approved alone no longer publishes an event.
4. New event titles need a reviewed mapping in the converter before they appear publicly. This prevents a newly added personal reminder from automatically reaching the website. Review the public title and safe venue; keep the original raw record out of git.
5. Refresh the public snapshot, or verify the live adapter after its separate activation. Calendar subscribers have their own refresh behavior, so changes are not guaranteed to appear instantly.

Creek Office’s **Private staff planning** rows remain separate internal records. Its Calendar page explains the iCloud editing route and links to the request sheet. No invitations have been sent and no iCloud settings changed.

## Refreshing the local snapshot

In the app repository, install the locked parser once with `npm --prefix tools/icloud-calendar ci --ignore-scripts`. Obtain a temporary local ICS copy through the authorized source without adding that raw file or its URL to a repository. Then run:

```sh
node tools/icloud-calendar/cli.mjs --input /private/path/calendar.ics --output events.json --ics-output calendar.ics
node tools/sync-calendar.cjs /path/to/local/website-checkout
```

The importer is local-only: it does not fetch a URL, log source data, change an account or publish. It reports counts and writes curated JSON/ICS. The source file must remain outside git and should be removed after the import. Run the website’s `python3 build.py`, both repositories’ public tests, and the importer tests; review the next events before committing the two feature branches. Never add the original publication URL to browser configuration.

## Automatic refresh — prepared, not activated

The app repository contains a read-only Supabase function at `supabase/functions/public-calendar/`. After the church-owned backend is separately approved, its operator stores the original URL as `CHURCH_CALENDAR_URL` in server-side environment configuration. The function serves only curated JSON and `?format=ics`; it has no iCloud write capability. Strict source-host validation, bounded fetch/parse work, limited caching, generic failure responses and synthetic tests are included.

Set the approved public function URL in the shared `js/calendar-config.js` only after deployment and verification, then synchronize the website. No secret or original feed URL goes in that file. The app caches only this exact public endpoint, never arbitrary backend APIs. Until activation, the candidate uses the dated static snapshot. A live endpoint changes the calendar download to its freshly curated ICS response.

Backend creation, editor invitations, deployment, DNS changes and the website cutover remain outside the current authorization. The prepared code is not evidence of a live connection.
