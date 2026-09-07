# Launch readiness · September 7, 2026

This feature branch consolidates the public app work already on `main` with Creek Office. It preserves the original Homestead brand and `/brand` library. It has not been deployed or connected to a live staff backend.

## Included behavior

- Private membership/care expansion: richer People records, preserved history/corrections and page-photo review, guest intake, assigned deacon/contact intervals, visit logs and an on-screen follow-up queue. The intended Google duplicate is not yet accessible, so no real records were imported and no Sheet write-back is claimed. See [membership and care maintenance](membership-care-maintenance.md).

- Grow adds a Home feature and primary tab for the Habakkuk series: dated latest passage, September 13 pause, sourced historical context, chapter guide and reading questions. The pause expires in Central time. Spotify and approved book sections are built; their selections remain pending Cole's playlist URL and book titles. Click-only playback and an external fallback are prepared; no actual audio has been tested. See [Grow maintenance](grow-maintenance.md).

- The public app and website use identical `js/calendar-feed.js` consumers of a curated iCloud calendar. The app owns the dated public JSON/ICS snapshot; recurring events, exceptions, cancellations, Central time and exclusive all-day spans are handled by the pinned parser. Personal metadata and unreviewed titles are excluded. The user confirmed Yoga at 3:45 p.m. and WMU at 5 p.m. Automatic refresh is prepared in a read-only server adapter but not activated. See [calendar maintenance](calendar-maintenance.md).
- Connection and prayer forms validate locally and open email drafts. They retain values on the current page, never report receipt, and do not store or POST entries. A user can explicitly remove legacy app drafts without the code reading their contents.
- The service worker caches only the known public shell and validated public feeds. Feeds use network-first responses and saved offline status. Admin paths, unrelated navigation and private API responses are excluded. Only the exact configured public calendar endpoint may be cached after activation. An update waits for old app windows to close so unfinished forms are not forcibly reloaded.
- Original fonts are served locally with their licenses. Phone routing, focus, text contrast and install-prompt behavior are reviewed.
- Creek Office provides private staff planning, membership/history and care records, categorized uploaded files and an audit log. Its calendar does not publish records to the public website. The authenticated interface explains separate Apple calendar editor invitations and links to iCloud. The calendar request sheet remains intake only; approved events must be entered in iCloud. The separate membership ledger awaits verified access.

## Reproducible local checks

From the app root, run `node --test tests/*.test.cjs` for public forms, shared calendar and service worker regressions. From `admin/tests`, run `npm ci --ignore-scripts` then `npm test` for the PostgreSQL role matrix and client session regressions. The latter uses PGlite and synthetic Auth/Storage structures; it does not validate a hosted service. See [staff test documentation](../admin/tests/README.md).

Browser checks use isolated local profiles and synthetic values where needed. Public drafts are never actually sent. Service-worker checks disable the browser network and verify a controlled reload, a reopened offline tab, validated saved public calendar data, local fonts/scripts and excluded admin/unrelated paths. A cached public calendar can miss a newly approved cancellation until reconnecting.

The iCloud converter has 17 synthetic tests; the HTTP adapter has 15, including real-converter integration. The current public client suite has 40 tests, including Grow link validation and dated series-pause behavior. The staff suite has 45 tests, including membership/care PostgreSQL policies, preserved sources, review forms and due dates. The integrated sample office passes desktop and 375/320-pixel phone checks for edits, photo review, corrections, guest/care workflows and sign-out clearing. The adapter Deno entry type-checks with its pinned parser. These checks did not contact or deploy a church backend.

## Required before staff activation

There is no church-owned project configured in `admin/config.js`. Account creation is outside the current authorization. After explicit approval, follow [Creek Office setup](../admin/README.md), create approved staff access, apply the schema in the new church project, and verify anonymous/nonstaff denial, each staff role, revoked access, file size/path rules and signed-link expiry against the actual hosted services. Run database/security advisors. Establish ownership, account recovery, backup/restore and departing-staff procedures before adding real records.

Uploaded spreadsheets are files to open/download; collaborative Sheet editing and synchronization are outside this version. Membership history and care require the additional migration and hosted access checks described in the setup guide. Photographed pages require manual transcription/review. On-screen care reminders are built; external follow-up messages and child check-in are not implemented. There is no public self-registration flow.

## Release order and rehearsal

Review and release the consolidated app PR before the companion website PR because the app owns the canonical curated calendar snapshot. Old overlapping P1 proposals should not be merged as a second calendar implementation. A specific ship instruction is required before any deployment or DNS change; preserve existing Google mail/MX configuration.

After separate backend approval, configure and verify the prepared public calendar adapter, including JSON/ICS output and the original feed held only as a server-side secret. With approved church staff, rehearse iCloud editor access, event changes/cancellations, a non-sensitive private file, real phone installation/reopening, mail-app delivery, YouTube stream/audio and the approved giving destination. These external journeys have not been completed by local automated tests. Record the deployed app/site revisions and current DNS before cutover so prior artifacts can be restored. Do not delete staff data as a rollback procedure.
