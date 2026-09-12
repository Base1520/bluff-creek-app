# A dependable Bluff Creek church system

September 12, 2026 · Product direction and implementation order

The standard is a warm, consistent experience for church families and an Office that clearly shows what happened, who is responsible and what needs attention. Every automation should leave a visible result and an accountable person.

## 1. Close the care loop

First finish explicit staff ownership, due-contact summaries, pastor escalation and notification-failure review. Make recording a call or visit quick on a phone. Preserve the distinction between an attempted contact and a successful one, and between initial guest follow-up and ongoing member care.

The care-reminder planner and the next server layer are implemented and locally tested: explicit ownership bindings, authoritative scheduling, a durable queue and a generic email worker. They remain source-only and disabled; Office controls, actual recipient selection and delivery activation/acceptance are next. Measure completed first contacts against the chosen due date, active-member care coverage and unresolved overdue items. Always show the eligible population and missing data; exclude inactive historical records from current-care goals.

## 2. A clear daily Office start page

Use the existing prepared Needs attention work for one concise view: new guests awaiting review, overdue care, unassigned responsibilities, failed deliveries and each person's private leadership follow-ups. Every item opens the authoritative record with a clear action. An unavailable source must show unavailable rather than zero. Reconcile the prepared view with removal and current-release safeguards before activation.

## 3. One approved weekly plan

Prepare this week's events, announcements, sermon details, slides and email from one reviewed weekly plan. Show draft, approved and published states, the owner and the last update. Preview each destination before release. The existing calendar, shared-week and weekly-email packages are separate pending work; do not publish them just because this roadmap exists.

## 4. Families keep their details current

Give adults a straightforward way to review their own contact preferences and household details, with a staff review queue for identity conflicts and membership changes. Preserve old information and provenance where appropriate. Never auto-merge people based on a matching name or shared household email. For handwritten history, retain page images and uncertainty for a human to resolve before import.

## 5. A useful installed app

Keep familiar Bluff Creek branding, readable text, clear buttons, fast pages and simple help for members who rarely use apps. Add notification choices by category after delivery is ready. Make new content, event changes and account updates visible without confusing saved forms or private Office sessions. Test real iPhones and Android phones, including a denied notification permission and a slow connection.

## 6. Sunday preparation with clear owners

Create a repeatable weekly preparation checklist for service content, print assets, livestream readiness and volunteer responsibilities. Show the owner, backup person and readiness of each item. The system should help staff hand off work without depending on one person's memory. Volunteer scheduling or attendance/check-in should be added only with defined operators and a rehearsed workflow.

## 7. Recovery and continuity

Finish actual database-plus-original-file restoration, permission checks, access removal and two-operator training. Show the last successful spreadsheet refresh, failed jobs and actionable configuration problems. Before every release, verify the exact current schema and preserve existing working features. A checklist completion count is not a guarantee of production readiness.

## Release order

1. Align release checking to the twelve verified migrations and preserve PR24 recovery/removal behavior.
2. Review the care reminder planner, implement explicit ownership and durable delivery, then rehearse real staff use.
3. Enable the compatible Needs attention view and test daily operating tasks.
4. Finish member opt-in push and one approved weekly communication flow.
5. Complete historical membership import, records maintenance, restore rehearsal and operator training.
6. Add volunteer/attendance improvements and the deferred missions merchandise store after the essential workflows are dependable.

This roadmap does not activate a migration, notification, account, campaign, release, purchase or data import. Progress is recorded separately as built, tested, approved, activated and accepted by an operator.
