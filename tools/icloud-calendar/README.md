# Local church calendar importer

This tool converts a local iCalendar file into a deliberately limited public calendar. It performs no downloads, account access, scheduling, publishing, or repository changes. The converter is reusable by a separately configured server, but this folder does not provision one.

## Install and run

Use Node.js 20 or later. Install the exact locked parser version with package scripts disabled:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
node cli.mjs --input /private/path/source.ics --output /private/path/public-calendar.json --ics-output /private/path/public-calendar.ics
```

`--input` and `--output` are required local filesystem paths. `--ics-output` is optional. For reproducible review, add `--now 2026-09-06T12:00:00Z`. The default is the current time. Existing destination directories must exist. The input and output paths must differ. Standard output contains counts only; errors contain a fixed code without input text or filenames.

Keep source feeds and their subscription addresses out of Git, logs, test fixtures, screenshots, and public folders. The ignore file blocks local `.ics` inputs and installed dependencies. Review generated JSON before selecting it as a public snapshot. Tests use synthetic calendars only.

## Pure converter contract

```js
import { convertCalendar } from './convert.mjs';
const { feed, counts, ics } = convertCalendar(sourceText, {
  now: new Date(),
  horizonDays: 90
});
```

`convert.mjs` imports only `ical.js`; it has no filesystem, environment, or network access. Its only input is text plus options. A Deno caller can map the bare import `ical.js` to `npm:ical.js@2.2.1`. An `ImportError` exposes a fixed, safe `code` and message; do not expose upstream parser errors or raw feed bodies.

The feed includes `source: "icloud"`, the Chicago `updated` date, a UTC `synced_at` timestamp, the inclusive `valid_until` date, `recurring: []`, and public `events`. The window is today through the following 89 church dates. `when` remains the actual start date, including an ongoing span that began earlier. Timed events show Chicago wall time and may include UTC ISO `endsAt`. All-day events use `time: "All day"`, `allDay: true`, and an **exclusive date** `endsAt`. An event from September 5 through September 7 has `when: "2026-09-05"` and `endsAt: "2026-09-08"`. Consumers must keep it through its end, rather than discard it solely because its start is past.

The optional ICS string contains expanded public occurrences with UTC timed starts/ends or date-only all-day spans. It contains only public title, safe location, dates, public class, generated opaque identifiers derived from the public occurrence fields, and standard calendar metadata. Original identifiers are never exported. Generated identifiers are deterministic and are not authentication tokens.

## Publication rules

Source titles must match the following reviewed set after trimming and case/whitespace normalization. The mapper supplies the public spelling; it does not publish arbitrary source titles.

- Business Meeting; Prayer Meeting
- Sunday School & Morning Worship; Sunday Morning Prayer; Sunday Evening Discipleship
- Yoga at BCBC; WMU Meeting
- Youth; Youth YEC; Youth Friend'sGiving Potluck; Youth - Christmas Party
- Women's Bible Study

Unknown titles are skipped without a public list. Events marked `CLASS:PRIVATE` or `CLASS:CONFIDENTIAL` are suppressed. A cancelled status or any title containing “cancelled” or “canceled” suppresses that occurrence. Unknown/private/cancelled overrides cannot inherit a public master title and reappear. A private master suppresses its series.

A location becomes “Bluff Creek Baptist Church” only when the source location clearly matches the approved church name, street address, or Sanctuary/Fellowship Building/Fellowship Hall. A blank source location may use an already verified room from the existing approved church schedule: Yoga and Youth use Fellowship Building, Prayer meeting and Sunday evening discipleship use Sanctuary, WMU uses Fellowship Hall, and combined Sunday School/worship uses Fellowship building & sanctuary. These are reviewed schedule facts, not inferred new venues. Every other location, including off-site conferences, unknown explicit venues, and specials with no venue, becomes “Check with the church for location.” Raw addresses, structured locations, and coordinates are never copied. Descriptions, people, attendees, organizers, URLs, attachments, alarms, and source identifiers are discarded in both output formats.

## Recurrence and failure behavior

The converter groups components by their internal source identifier before relating exceptions, retains the true recurrence start, and expands rules with the official event iterator. It honors EXDATE, moved occurrences, cancellation tombstones without a start, and THISANDFUTURE changes. An explicit detached override takes precedence over EXDATE for its original slot and is emitted once if public and in the window. A moved occurrence can enter the window from a distant original date. Duplicate public occurrences are collapsed. Results sort by date, all-day first, then time and title.

Embedded VTIMEZONE definitions resolve named zones; an explicit zone without a definition fails closed. Floating times are interpreted as America/Chicago. Normal DST transitions preserve wall times. The pinned parser can mis-handle a recurrence scheduled in the nonexistent spring-forward hour; the importer detects that condition and fails with `NONEXISTENT_WALL_TIME` instead of silently shifting the time or publishing an incorrect recurrence count. Correct the source schedule before retrying that case.

Resource limits are explicit: 2 MiB input, 10,000 components, 25,000 recurrence candidates per series, 250,000 candidates overall, and 5,000 public occurrences. Historical candidates count toward the limits. Daily, weekly, monthly, and yearly rules are accepted, with bounded expansion combinations, at most 16 rules per series, and at most 10,000 explicit recurrence/exclusion dates per series. Higher-frequency rules, EXRULE, and period-valued RDATE are rejected. Plain date/date-time RDATE is supported. A limit or unsupported construct fails the entire conversion rather than emit a partial calendar.

Conversion and validation finish before any destination is written. Each output is staged in its destination directory and renamed atomically; malformed input preserves all previous outputs. When two output files are requested, the two final renames are **not** a filesystem transaction: a later I/O failure can leave one updated and one previous file. Re-run after resolving that failure. No conversion or CLI action publishes either file.

## Parser and references

The dependency and lockfile pin official **ical.js 2.2.1**, the verified current stable release. The dependency uses MPL-2.0 and is installed rather than vendored. Recheck official releases and rerun the synthetic edge suite before updating the pin.

- [Official release](https://github.com/kewisch/ical.js/releases/tag/v2.2.1)
- [Official parsing guide](https://github.com/kewisch/ical.js/wiki/Parsing-iCalendar)
- [Event occurrence API](https://kewisch.github.io/ical.js/api/ICAL.Event.html)
- [Recurrence expansion API](https://kewisch.github.io/ical.js/api/ICAL.RecurExpansion.html)
- [RFC 5545: events and exclusive end dates](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.6.1)
- [RFC 5545: recurrence rules and invalid local times](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10)
