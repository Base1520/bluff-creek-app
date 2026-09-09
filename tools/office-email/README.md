# Creek Office authentication email templates

Two prepared templates carry the original Homestead colors into staff invitations and password recovery. They use inline styles, presentation tables, readable serif/sans-serif fallbacks and live text. No remote image, font, script, tracking pixel, recipient address, password or token is embedded in the source.

Subjects are in `manifest.json`. On the intended church project, the reviewed HTML belongs in Supabase **Authentication → Emails → Invite user / Reset password**, after the email and release steps below are approved. These files are outside the static release allowlist and are never deployed by the app packaging tool. No hosted setting or email has been changed by preparing them.

## Link contract

Both the button and fallback retain the exact supported `{{ .ConfirmationURL }}` variable. Supabase constructs the verification link using the requested callback. Keep the existing implicit invite/recovery flow and exact `https://app.bluffcreekbaptistchurch.org/admin/recovery.html` redirect; do not substitute an SSR/token-hash link into this client.

The invitation describes the new manual access check: an otherwise valid confirmed invitation with no staff role can remain on the setup page while the administrator finishes the grant. It never creates staff access. Reset links and identity/query failures remain closed. This wording requires the matching recovery-page revision to be released with the template.

The confirmation link is private. Disable provider click/open tracking for these transactional messages. Email security scanners can consume single-use links; actual inbox testing must cover this, and a scanner-resistant confirmation flow would be separate implementation. The current template does not claim to solve scanner consumption.

## Ordered activation

1. Confirm the intended Supabase project and independently compare its existing settings. The connected database tools do not supply the Auth configuration interface; use the authorized dashboard or supported Management API. Do not extract connector credentials.
2. Publish the separately approved exact office/recovery candidate and verify HTTPS routes, asset hashes and expected recovery UI. The additive office packet must not introduce member signup; any included public connection settings stay blank. **September 8 observation:** the public /admin/ and /admin/recovery.html paths currently return GitHub Pages 404. No invitation is usable at that callback yet.
3. Select and verify the approved SMTP provider, sender identity/domain and required DNS changes. Supabase default email is restricted to organization-team recipients and is not a production delivery route. Do not grant church operators organization access merely to bypass that restriction. Provider ownership, sender and costs remain unselected.
4. Review exact redirect allowlist and staff-only Auth signup posture. The already-applied database profile-write pause does not disable Auth signup.
5. Compare the subjects and both templates, then apply only on the specific email-setting instruction. Save a private before/after settings record; no credentials or generated recipient links belong in Git or shared notes.
6. Create/reconcile the authorized identities through the selected process and use the identity-bound administrator setup. Normal invitations send immediately before the separate role grant, so coordinate recipient timing; no automatic duplicate invitations or account creation.
7. Test delivery and inbox rendering with the authorized recipients/devices: working button and fallback, confirmed first password, pending-role retry, expired/used links, reset, revoked role and manual sign-in. Review sender and delivered authentication headers privately. A browser rendering preview proves neither actual mail delivery nor email-client layout.

Sources checked September 8, 2026: [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates), [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [production link/scanner guidance](https://supabase.com/docs/guides/deployment/going-into-prod).

Run `node --test tools/office-email/email.test.mjs` for the template/link boundary checks. Local design previews must use an inert placeholder in place of the confirmation URL; never preview a real recipient link in a shared browser or screenshot.
