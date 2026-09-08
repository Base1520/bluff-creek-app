# Creek Office: after-demo activation

Prepared September 8, 2026. This is the wiring and acceptance path for the private office. Preparing files does not apply schema, grant staff access, enable signup or deploy the app. Today's local demonstration remains available separately.

## Reviewed destination

- Project: **Bluff Creek Church Office**, dedicated project within the existing Base1520 organization.
- Project reference: `xzfeumdonxeodqhfirjr`, us-east-1.
- Proposed existing app origin: `https://app.bluffcreekbaptistchurch.org`.
- Staff page: `/admin/`. Password recovery and first-password callback: `/admin/recovery.html`.
- Public connection callback: `/connection.html`, only included in a separately selected public-signup configuration.

September 8 read-only inventory: ACTIVE_HEALTHY; **zero public tables, zero Auth users and zero storage buckets**; no migration-history table and no `office_readiness()` function. This is a dated observation, not a lock against later changes. Recheck before applying the first migration. The existing modern publishable key was retrieved for private local staging; no key was created or rotated. A read-only Auth settings request with that key returned HTTP200. It reported `disable_signup: false` and `mailer_autoconfirm: false`: new-user signup is currently allowed and automatic email confirmation is off. No setting was changed; this does not prove hosted mail delivery or accept public signup.

## Wiring prepared

Use the [offline wiring tool](../tools/office-wiring/README.md) with a private JSON input file. It checks that the project reference and URL agree, accepts only a modern publishable browser key, requires an exact HTTPS app origin, and produces consistent staff and optional member settings in a **new staging directory**. It never modifies the source checkout or connects to a service. Review the staged files before placing them in a release.

The first packet is **staff browser configuration only**: `publicSignupEnabled` is false, so member connection settings stay blank and only the staff callback is proposed. An opaque publishable key cannot be matched to a project offline; its provenance and actual hosted behavior must be checked separately. The local staged key was retrieved from the intended project's API, but hosted sign-in is still untested.

A blank public configuration makes the member connection page unavailable. It does **not** disable Supabase signup or the authenticated profile-submission functions. The seventh migration now pauses both profile-submission functions by default for staff-first activation. This is effective only after application and grant verification; the hosted project is still empty. Auth signup and email settings remain separate. Review hosted Auth's new-signup policy explicitly. Never copy the local rehearsal's signup-enabled Auth configuration, loopback origins, captured-mail settings or fictional login into the hosted project.

The private spreadsheet identifier is intentionally excluded from generated browser assets. The optional shortcut does not synchronize Google Sheets and Google permissions remain independent. Agree a suitable access path before configuring a real source link in a public static release.

## Ordered activation and acceptance

| Step | Work and evidence required | Current state |
| --- | --- | --- |
| 1. Owners and visibility | Name a primary and backup administrator privately; choose initial roles. Admin/editor accounts currently have broad office access. Assigned-deacon/teacher-only access is not built. | Church decision |
| 2. Exact schema | Recheck destination and empty schema/history, review the six unchanged baseline hashes plus the seventh intake-pause migration and pending list, then apply the approved tracked sequence. Stop and reconcile unexpected objects/history. | Local sequence passed; hosted apply pending |
| 3. Hosted sign-in | Review exact HTTPS origin and `/admin/recovery.html` callback. Configure the approved email provider and signup posture, then assign approved real identities through the reviewed access process. | Staged browser settings; hosted configuration and invitations pending |
| 4. Hosted verification | Rehearse fictional viewer/editor/admin/nonstaff and revoked-access cases; password reset/first password; private source uploads/downloads; stale/interrupted saves and separate personal leadership notes. | Local service passed; hosted evidence pending |
| 5. Recovery | Establish database **and original uploaded-file** copies, approved separate restore destination, retention and operators. Restore both and compare records/policies/source bytes; record loss window and recovery time. | Local restore passed; hosted/off-device arrangement pending |
| 6. Operator pilot | Primary and backup independently complete and recover ordinary office work. Record actual results in the pilot worksheet and resolve failures. | Worksheets prepared; acceptance pending |
| 7. Release and records | Review exact app release, browser settings and rollback. Release only on the final instruction. Import a small approved membership batch only after separate source/identity/mapping and restore gates. | Separate release/import decisions |

The existing [migration guide](office-migrations.md) is the authoritative seven-file sequence; the [launch board](launch-readiness.md) records overall scope. General Documents are available to viewers. Restricted material must stay outside general uploads until an appropriate access model exists.

## Public signup follows its own rehearsal

When separately selected, the tool stages the same project/key for `/connection.html` with the exact app origin in `allowedOrigins`. The complete migration sequence pauses profile creation/updates even if public browser settings are populated. Reopening needs a separately reviewed migration; a frontend setting cannot reopen it. Before promoting it, verify real email delivery and callback behavior, profile submission/update, staff review, existing-person linking or explicit visitor creation, exactly one welcome task, contact preferences and access removal. Installation alone does not create a person. Staff assignment names do not grant accounts, and on-screen care queues do not deliver notifications. One Call work remains deferred.

Public website/app release can proceed on its own approved path while private activation and historical import finish. Keep the existing ledger and operating services available through the transition; avoid untracked edits in two authoritative records.

## Configuration checks fixed

Staff login now applies the same hosted endpoint restrictions used by recovery and public connection: a root Supabase HTTPS URL without credentials, nondefault port, path suffix, query or fragment. Staff login and recovery use modern publishable keys for hosted use; legacy anon tokens remain only for the explicit loopback rehearsal. Both refuse privileged keys before client creation. This prevents a malformed setting from appearing to work at login but failing at recovery; it does not verify project ownership, authorization policies or live email.

Source checks: [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys), [exact Auth redirects](https://supabase.com/docs/guides/auth/redirect-urls), [production email and availability guidance](https://supabase.com/docs/guides/deployment/going-into-prod). The current changelog was reviewed, including the default-SMTP email-template restriction for new Free projects. Production email and backup costs still need a concrete selection; the earlier $0 project-creation quote is not a full operating budget.

## Complete release files

The [offline release builder](../tools/office-release/README.md) packages the actual public app and private office pages, including connection and password recovery, into a dedicated `site/` directory. It uses a fixed asset inventory and generated hosted settings, preserving source files. SQL, tests, working notes and private configuration inputs are excluded. The sibling review report records file hashes and pending hosted checks. The output is a local release candidate, not a preview server or deployment.
