# One public calendar

The app and website read the same sources: the app-owned `events.json` for the verified recurring rhythm and the published **Approved** Google Sheet for reviewed additions, changes, and cancellations. Their `js/calendar-feed.js` files are identical. The normal build does not need network access or a credential.

The calendar expands the verified weekly schedule and third-Tuesday WMU for the next 42 days. It also accepts dated rows for exceptions and older consumers. Duplicate date/title pairs appear once. Upcoming lists use America/Chicago, remove elapsed start times, and never restore old events when a feed expires. An event with an unspecified time says “Time to be confirmed.”

## Reviewing public submissions

Members use the **Add an event** link in the app Calendar or website When We Meet page. The existing Google Form sends a request for review. Only rows with the exact Approved status in the private sheet reach the public feed.

1. Check the title, date, time, and public location/details. Keep personal contact information and internal notes out of public event fields.
2. Approve an addition to place it on both calendars. Publication may take a few minutes.
3. A change with the same date and title replaces that occurrence's time/location/details. Date/title matching ignores letter case and repeated spaces.
4. A cancellation removes the matching date/title from the public list, including a regular gathering. It does not cancel later weeks.
5. To move an event to another date or rename it, approve a cancellation using the original date/title, then approve an addition using the new values. The current form has no stable event ID, so the consumer does not guess which differently named event to remove.
6. If multiple approved requests affect the same date/title, the last row in the published feed wins. Remove or correct superseded requests in the approval sheet when needed.

The consumer reads only Title, Date, Start, Location, Details, and Type. It never renders the Note column or the private submitter columns. An empty approved feed is valid; malformed responses do not become public events.

## Offline behavior

The app fetches both feeds from the network first and can use their previously saved public responses offline. If community updates are unavailable, it keeps the verified regular rhythm and says that updates are unavailable. Offline phones can miss a recent cancellation until reconnecting; check the displayed status. No private staff pages, API responses, prayer requests, or connection cards belong in the public service-worker cache.

## Changing the recurring rhythm

Edit `events.json` only for a verified ongoing schedule change. The `recurring` entries use Sunday = 0 through Saturday = 6; an optional `ordinal` selects a week within the month. Keep the documented church times and public locations. Additions/cancellations for a specific day normally belong in the approval sheet.

Run `node tools/sync-calendar.cjs /path/to/local/website-checkout` to update the embedded offline fallback, identical website consumer, and website build data. Run the website's `python3 build.py`, then both repositories' calendar tests. This tool edits local files only; it does not publish anything.

## Creek Office

Creek Office's staff calendar is private planning data. It does not automatically publish database records to the public site. Staff use the approval-sheet link inside the workspace to review the public calendar. Keeping the Google approval workflow as the publication source avoids exposing private staff events or bypassing review.
