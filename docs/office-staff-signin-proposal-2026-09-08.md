# Staff sign-in: concrete next changes

Prepared September 8, 2026 for the existing Bluff Creek Church Office project, `xzfeumdonxeodqhfirjr`. Schema is applied and catalog verified. This document proposes the next changes; none has been applied. No staff account, invitation or real record exists.

## Observed now

| Setting or route | Actual read-only observation |
| --- | --- |
| Custom SMTP | Disabled in the signed-in project dashboard |
| Auth Site URL | `http://localhost:3000` |
| Auth redirect allowlist | Empty |
| Auth public signup | Allowed in the last public settings GET |
| Email automatic confirmation | Off in that GET |
| `/admin/` and `/admin/recovery.html` on the intended app origin | Both HTTP404, GitHub Pages |
| Auth users / staff role rows / stored objects | 0 / 0 / 0 |

## Proposed Auth patch

After approval, change only these fields, preserving every unrelated setting. Re-read current values immediately beforehand; stop and reconcile an unexpected change.

```json
{
  "site_url": "https://app.bluffcreekbaptistchurch.org/admin/recovery.html",
  "uri_allow_list": "https://app.bluffcreekbaptistchurch.org/admin/recovery.html",
  "disable_signup": true
}
```

The complete recovery URL is deliberate for this staff pilot: it is also the default destination when an invitation omits an explicit redirect. The public homepage does not process staff invitation tokens. Explicit invitation/reset requests still use that same callback. Use no wildcard, loopback URL or public connection callback. Keep email confirmation enabled (`mailer_autoconfirm=false`); the three-field patch does not change it. Keep the email provider enabled. Admin invitation remains a privileged provisioning action, separately authorized from disabling public self-signup. Existing database profile-write denial remains in place.

This is a temporary staff-only Auth posture. Before opening public signup later, review Site URL and both exact callbacks again, implement the separately reviewed database reopening, and complete actual signup/email/intake acceptance. Do not blindly restore the old localhost value during rollback of a live pilot; pause new provisioning and preserve working existing accounts while reviewing the rollback.

## Smallest static release

Pinned comparison: public main `3d001e53145cd04d0d2f249bd2f88f78570edbbd`. Preserve all 20 current files, including CNAME and the eight brand paths. Add 25 office/font/license files; the existing logo is byte-identical and reused. The source browser config remains blank in Git; only the private reviewed release packet receives the existing intended publishable key. No private spreadsheet URL belongs in static files.

One existing file needs a reviewed exception: current main's `sw.js` caches office navigations into the public homepage cache. The narrow proposed worker bypasses staff and cross-origin requests and confines public navigation caching to successful home responses. This is a real change to public offline behavior, even though the public HTML, events and branding stay byte-identical. It is not the much broader candidate `creek-v12` release. Verify an already-controlled browser upgrades before using staff pages; a new worker cannot retroactively prevent an older active worker from handling the first visit.

No deployment or merge is authorized by preparation. Recheck main and exact asset hashes before release; regenerate and review if main changed. A separately approved release must produce real HTTPS200 staff/recovery pages, correct hashes and a confirmed safe worker transition before email links are usable.

## Email and first access

The [two branded email templates](../tools/office-email/README.md) are prepared, with their exact Supabase confirmation variable retained. They are not installed. Custom SMTP needs a separately approved provider, sender identity, ownership and cost. Do not use wider Supabase organization membership to make church operators eligible for restricted default email. Do not invent SMTP credentials, create accounts, change DNS or send mail from this proposal.

After the live routes, approved Auth posture and real SMTP are verified, reconcile the two privately selected administrator identities. An invitation sends immediately and precedes its separate staff grant. The new callback can wait safely for a verified invitation with no role; manual checks reverify identity and access. Use the identity-bound access tool, then independently verify first password, manual sign-in, reset, expired/reused links, revoked access and private file behavior. Neither branded HTML nor synthetic tests prove inbox delivery.

Real membership import, role-limited deacon/teacher access, off-device database plus original-file recovery and primary/backup acceptance remain their own open work. Existing demonstrations and the original ledger stay available.

References checked September 8: [Auth configuration fields](https://supabase.com/docs/reference/api/v1-update-auth-service-config), [exact redirect behavior](https://supabase.com/docs/guides/auth/redirect-urls), [SMTP restrictions](https://supabase.com/docs/guides/auth/auth-smtp), [email template variables](https://supabase.com/docs/guides/auth/auth-email-templates).
