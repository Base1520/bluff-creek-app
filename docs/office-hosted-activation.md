# Creek Office: after-demo activation

**September 9 schema update:** the explicitly approved account guard is now applied as version `20260909124122`, with exact approved bytes and 14 pre/14 post catalog checks. The active setup requires eight migrations. Verify existing hosted versions; do not replay them. This is schema/catalog evidence, not staff sign-in, email or release acceptance. See the [guard record](office-account-guard-hosted-2026-09-09.md). Earlier September 8 observations below remain dated evidence.

Updated September 8, 2026 after the approved hosted schema application. This is the wiring and acceptance path for the private office. Staff access, email, hosted acceptance and release remain open. Today's local demonstration remains available separately.

## Reviewed destination

- Project: **Bluff Creek Church Office**, dedicated project within the existing Base1520 organization.
- Project reference: `xzfeumdonxeodqhfirjr`, us-east-1.
- Proposed existing app origin: `https://app.bluffcreekbaptistchurch.org`.
- Staff page: `/admin/`. Password recovery and first-password callback: `/admin/recovery.html`.
- Public connection callback: `/connection.html`, only included in a separately selected public-signup configuration.

September 8 hosted update: following explicit schema-only approval and a fresh empty-target check, all seven migrations were applied. The hosted project now has **17 office tables, seven migration-history entries and one private document bucket**. All seven hosted SQL SHA-256 values match the approved source exactly; current local migration versions match the tool-recorded history. RLS, table/RPC privileges, Storage policies and readiness definition passed catalog verification; the security advisor returned no findings. All office tables, Auth users/identities/sessions and stored objects remain empty. [Dated evidence and limits](office-hosted-verification-2026-09-08.md).

The existing modern publishable key was retrieved for private local staging; no key was created or rotated. The last read-only Auth settings GET returned HTTP200 with `disable_signup: false` and `mailer_autoconfirm: false`. No Auth setting was changed. This does not prove hosted mail delivery or accept public signup. Two intended administrator identities have been supplied privately; accounts, roles and invitations have not been created.

Later September 8, the signed-in dashboard confirmed custom SMTP is off, Site URL is still `http://localhost:3000`, and the redirect allowlist is empty. Anonymous HTTPS requests to both proposed staff routes returned GitHub Pages 404. Accounts and staff grants remain zero. These settings and routes must be resolved before invitations. The [concrete staff sign-in proposal](office-staff-signin-proposal-2026-09-08.md) records the exact pending changes and their separate release/email dependencies.

## Wiring prepared

Use the [offline wiring tool](../tools/office-wiring/README.md) with a private JSON input file. It checks that the project reference and URL agree, accepts only a modern publishable browser key, requires an exact HTTPS app origin, and produces consistent staff and optional member settings in a **new staging directory**. It never modifies the source checkout or connects to a service. Review the staged files before placing them in a release.

The first packet is **staff browser configuration only**: `publicSignupEnabled` is false, so member connection settings stay blank and only the staff callback is proposed. An opaque publishable key cannot be matched to a project offline; its provenance and actual hosted behavior must be checked separately. The local staged key was retrieved from the intended project's API, but hosted sign-in is still untested.

A blank public configuration makes the member connection page unavailable. It does **not** disable Supabase signup or change database privileges. The seventh migration has now been applied and both profile-submission function grants were verified denied for browser roles. Auth signup and email settings remain separate. Review hosted Auth's new-signup policy explicitly. Never copy the local rehearsal's signup-enabled Auth configuration, loopback origins, captured-mail settings or fictional login into the hosted project.

The private spreadsheet identifier is intentionally excluded from generated browser assets. The optional shortcut does not synchronize Google Sheets and Google permissions remain independent. Agree a suitable access path before configuring a real source link in a public static release.

## Ordered activation and acceptance

| Step | Work and evidence required | Current state |
| --- | --- | --- |
| 1. Owners and visibility | Two intended administrators are supplied privately. Use the identity-bound access preparation path; wider staff roles still need selection. Admin/editor accounts currently have broad office access. Assigned-deacon/teacher-only access is not built. | Initial identities selected; wider visibility decision open |
| 2. Exact schema | Original seven migrations plus the September 9 account guard are applied. All approved statement hashes and recorded versions are retained; fresh setup requires all eight, existing hosted setup verifies them without replay. | Eight-migration schema applied; signed-in acceptance separate |
| 3. Hosted sign-in | Review exact HTTPS origin and `/admin/recovery.html` callback. Configure the approved email provider and signup posture, then assign approved real identities through the reviewed access process. | Staged browser settings; hosted configuration and invitations pending |
| 4. Hosted verification | Rehearse fictional viewer/editor/admin/nonstaff and revoked-access cases; password reset/first password; private source uploads/downloads; stale/interrupted saves and separate personal leadership notes. | Local service passed; hosted evidence pending |
| 5. Recovery | Establish database **and original uploaded-file** copies, approved separate restore destination, retention and operators. Restore both and compare records/policies/source bytes; record loss window and recovery time. | Local restore passed; hosted/off-device arrangement pending |
| 6. Operator pilot | Primary and backup independently complete and recover ordinary office work. Record actual results in the pilot worksheet and resolve failures. | Worksheets prepared; acceptance pending |
| 7. Release and records | Review exact app release, browser settings and rollback. Release only on the final instruction. Import a small approved membership batch only after separate source/identity/mapping and restore gates. | Separate release/import decisions |

The existing [migration guide](office-migrations.md) is the authoritative eight-file sequence; the [launch board](launch-readiness.md) records overall scope. General Documents are available to viewers. Restricted material must stay outside general uploads until an appropriate access model exists.

## Public signup follows its own rehearsal

When separately selected, the tool stages the same project/key for `/connection.html` with the exact app origin in `allowedOrigins`. The complete migration sequence pauses profile creation/updates even if public browser settings are populated. Reopening needs a separately reviewed migration; a frontend setting cannot reopen it. Before promoting it, verify real email delivery and callback behavior, profile submission/update, staff review, existing-person linking or explicit visitor creation, exactly one welcome task, contact preferences and access removal. Installation alone does not create a person. Staff assignment names do not grant accounts, and on-screen care queues do not deliver notifications. One Call work remains deferred.

Public website/app release can proceed on its own approved path while private activation and historical import finish. Keep the existing ledger and operating services available through the transition; avoid untracked edits in two authoritative records.

## Configuration checks fixed

Staff login now applies the same hosted endpoint restrictions used by recovery and public connection: a root Supabase HTTPS URL without credentials, nondefault port, path suffix, query or fragment. Staff login and recovery use modern publishable keys for hosted use; legacy anon tokens remain only for the explicit loopback rehearsal. Both refuse privileged keys before client creation. This prevents a malformed setting from appearing to work at login but failing at recovery; it does not verify project ownership, authorization policies or live email.

Source checks: [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys), [exact Auth redirects](https://supabase.com/docs/guides/auth/redirect-urls), [production email and availability guidance](https://supabase.com/docs/guides/deployment/going-into-prod). The current changelog was reviewed, including the default-SMTP email-template restriction for new Free projects. Production email and backup costs still need a concrete selection; the earlier $0 project-creation quote is not a full operating budget.

## Complete release files

The [offline release builder](../tools/office-release/README.md) packages the actual public app and private office pages, including connection and password recovery, into a dedicated `site/` directory. It uses a fixed asset inventory and generated hosted settings, preserving source files. SQL, tests, working notes and private configuration inputs are excluded. The sibling review report records file hashes and pending hosted checks. The output is a local release candidate, not a preview server or deployment.

That 49-file packet is a full candidate, **not** an overlay for the current public app. Compared with current main it replaces three public files and omits CNAME and eight brand paths. Do not publish it as a staff-only replacement. A narrow alternative preserves current main, adds the office dependency closure, and separately corrects the old public service worker so it cannot cache office responses as the homepage. See the staff sign-in proposal and the reviewed worker under `tools/office-staff-release/`; neither artifact authorizes release.
