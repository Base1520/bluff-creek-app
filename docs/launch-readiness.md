# Launch readiness · September 6, 2026

This feature branch consolidates the public app work already on `main` with Creek Office. It preserves the original Homestead brand and `/brand` library. It has not been deployed or connected to a live staff backend.

## Included behavior

- The public app and website use identical `js/calendar-feed.js` consumers. The app owns `events.json`, including the verified ongoing schedule. Approved Google CSV additions, edits and cancellations overlay that schedule. Central time removes elapsed starts; missing community updates are described honestly. See [calendar maintenance](calendar-maintenance.md).
- Connection and prayer forms validate locally and open email drafts. They retain values on the current page, never report receipt, and do not store or POST entries. A user can explicitly remove legacy app drafts without the code reading their contents.
- The service worker caches only the known public shell and validated public feeds. Feeds use network-first responses and saved offline status. Admin paths, unrelated navigation and API responses are excluded. An update waits for old app windows to close so unfinished forms are not forcibly reloaded.
- Original fonts are served locally with their licenses. Phone routing, focus, text contrast and install-prompt behavior are reviewed.
- Creek Office provides private staff planning, basic contact/member records, categorized uploaded files and an audit log. Its calendar does not publish records to the public website. The authenticated interface links to the existing public approval sheet.

## Reproducible local checks

From the app root, run `node --test tests/*.test.cjs` for public forms, shared calendar and service worker regressions. From `admin/tests`, run `npm ci --ignore-scripts` then `npm test` for the PostgreSQL role matrix and client session regressions. The latter uses PGlite and synthetic Auth/Storage structures; it does not validate a hosted service. See [staff test documentation](../admin/tests/README.md).

Browser checks use isolated local profiles and synthetic values where needed. Public drafts are never actually sent. Service-worker checks disable the browser network and verify a controlled reload, a reopened offline tab, validated saved JSON/CSV, local fonts/scripts and excluded admin/unrelated paths. A cached public calendar can miss a newly approved cancellation until reconnecting.

## Required before staff activation

There is no church-owned project configured in `admin/config.js`. Account creation is outside the current authorization. After explicit approval, follow [Creek Office setup](../admin/README.md), create approved staff access, apply the schema in the new church project, and verify anonymous/nonstaff denial, each staff role, revoked access, file size/path rules and signed-link expiry against the actual hosted services. Run database/security advisors. Establish ownership, account recovery, backup/restore and departing-staff procedures before adding real records.

Uploaded spreadsheets are files to open/download; collaborative editing and version history are outside this version. Contacts support basic records and search; automated follow-up campaigns and child check-in are not implemented. There is no public self-registration flow.

## Release order and rehearsal

Review and release the consolidated app PR before the companion website PR because the app owns the canonical recurring feed. Old overlapping P1 proposals should not be merged as a second calendar implementation. A specific ship instruction is required before any deployment or DNS change; preserve existing Google mail/MX configuration.

With approved church staff, rehearse event approval/cancellation, a non-sensitive private file, real phone installation/reopening, mail-app delivery, YouTube stream/audio and the approved giving destination. These external journeys have not been completed by local automated tests. Record the deployed app/site revisions and current DNS before cutover so prior artifacts can be restored. Do not delete staff data as a rollback procedure.
