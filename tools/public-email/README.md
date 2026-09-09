# Home @ the Creek — public sign-in emails

Prepared September 8, 2026. **Templates and subjects only; no hosted email setting was changed and no message was sent.** These files remain outside the static release allowlists.

The two HTML files reuse the original Homestead staff-email layout: ivory, pine and wheat colors, inline presentation tables, serif/sans-serif fallbacks and live text. They carry Home @ the Creek wording, distinguish email verification from submitting connection details, and make no membership or messaging-subscription promise. They contain no recipient address, password, token, personal profile field, remote asset or tracking pixel.

## Which template the app uses

`js/connection.js` calls `signInWithOtp` with `shouldCreateUser: true` and an explicit public `emailRedirectTo`. The client is configured for the implicit flow. Although the method says OTP, retaining `{{ .ConfirmationURL }}` produces a clickable sign-in/verification link. [Supabase passwordless email guide](https://supabase.com/docs/guides/auth/auth-email-passwordless)

With **email confirmation required** (`Mailer.Autoconfirm=false`), current upstream Auth uses:

| Account state | Supabase template | Prepared file and subject |
| --- | --- | --- |
| New account, or an existing account whose email is still unconfirmed | Confirm signup (`confirmation`) | `confirmation.html` — Confirm your email · Home @ the Creek |
| Existing account with a confirmed email | Magic Link (`magic_link`) | `magic-link.html` — Your sign-in link · Home @ the Creek |

The official implementation routes email OTP requests through `MagicLink`. Its new/unconfirmed branch invokes `Signup` and sends confirmation; confirmed accounts receive a magic link. If email auto-confirm is enabled, the new-user branch creates the account and then sends a magic link. This packet does not change that setting or recommend enabling it. [OTP source](https://github.com/supabase/auth/blob/master/internal/api/otp.go), [MagicLink branching](https://github.com/supabase/auth/blob/master/internal/api/magic_link.go), [Signup source](https://github.com/supabase/auth/blob/master/internal/api/signup.go)

The mailer maps `ConfirmationMail` to `confirmation` and verification type `signup`, and `MagicLinkMail` to `magic_link` and type `magiclink`. The corresponding Management API body fields are `mailer_templates_confirmation_content` and `mailer_templates_magic_link_content`; the subjects are listed in the local manifest. Use the matching named dashboard templates when applying an approved change. Staff Invite user and Reset password templates remain separate. [Official template implementation](https://github.com/supabase/auth/blob/master/internal/mailer/templatemailer/templatemailer.go), [Supabase email-template documentation](https://supabase.com/docs/guides/auth/auth-email-templates)

This is verified **current upstream behavior**, not proof of the project's deployed Auth version or email delivery. A custom Send Email Hook can replace built-in template delivery. Before activation, check the actual hook/template settings and verify both a first-time/unconfirmed and a returning-user email journey. `hosted_template_routing_verified` remains false in the manifest.

## Link contract

Both the action button and complete fallback link retain the exact `{{ .ConfirmationURL }}` variable. Supabase constructs the verification URL; the email does not construct or rewrite a token-bearing URL. The intended callback is exactly:

`https://app.bluffcreekbaptistchurch.org/connection.html`

The callback must be hosted and explicitly allowlisted. `js/connection.js` supplies it as `emailRedirectTo`; do not replace the variable with the Site URL, which may intentionally default to staff recovery. Preserve the staff callback and review both flows together. [Supabase redirect rules](https://supabase.com/docs/guides/auth/redirect-urls)

After verification, the existing public handler accepts implicit access/refresh tokens with types `signup`, `magiclink`, `email` or empty, strips them before SDK use, and validates the Auth user. It rejects staff invitation/recovery types. It does not implement a six-digit code field, a standalone token-hash exchange or a PKCE code exchange. Do not substitute `.Token`, `.TokenHash`, `.RedirectTo` or an SSR confirmation route into these templates. [Verification implementation](https://github.com/supabase/auth/blob/master/internal/api/verify.go)

Disable email-provider link/open tracking for these transactional messages. Security scanners can consume single-use confirmation links before the recipient clicks; these templates preserve the current flow and do not claim to prevent that. Actual inbox testing must cover expired/used links, both button and fallback, and the recipient's mail clients. [Supabase email link limitations](https://supabase.com/docs/guides/auth/auth-email-templates)

## Activation boundary and verification

Finish the real office/SMTP acceptance, then separately approve the exact public Auth/template/configuration changes and optional intake reopening migration. These templates neither enable self-signup nor restore profile-write permission. A verified session alone does not create an office person or welcome task; the person must submit details and staff must review them. The existing Connect and Prayer mailto forms remain drafts sent through the visitor's own email app.

Run the offline checks from the repository root:

```sh
node --test tools/public-email/email.test.mjs
```

The tests verify supported variables, unmodified synthetic action/fallback links, inert/private markup, isolation from static release files, and compatibility with the actual public callback parser. They contain no exact-copy wording assertions. No delivery, hosted configuration or email-client rendering result is claimed. Use inert placeholders for visual previews; never paste a real recipient's confirmation link into source, logs, Git or shared screenshots.
