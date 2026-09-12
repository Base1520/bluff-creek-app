# Care follow-up email worker — prepared, disabled

This source package adds a separate reminder queue for ongoing care and guest
follow-up. It is **not deployed or scheduled**. Its proposed database settings
start disabled with no pastor recipients or approved ownership bindings.

Only an authenticated server job with a dedicated `X-Creek-Care-Job-Key` can call
the worker. Browser origins, user tokens, arbitrary recipients, content and query
parameters are not accepted. The body is exactly `{}`. The entry point reads
`SUPABASE_URL`, the explicitly selected service key, `CREEK_CARE_RESEND_KEY` and
`CREEK_CARE_JOB_SECRET` (64 lowercase hexadecimal characters). No keys are supplied
in this package. The project and provider destinations are fixed.

The database derives recipients and work from current approved staff accounts,
care plans, contact history, guest actions and removal state. Enqueueing and
claiming happen through separate service-only RPCs; a browser planner cannot
authorize delivery. Claims contain only the minimal private transport envelope.

The worker claims one job immediately before attempting it, up to five jobs per
invocation. Each outbound request has an eight-second deadline and refuses
redirects. It stops on the first failure so unattempted jobs retain no leases.
Messages contain a generic Office link, with no member, guest, prayer or visit
details. The recipient is resolved from the current eligible account at claim.

## Recorded outcomes

- `accepted`: the provider returned a valid message ID and the database recorded
  it. This does not establish inbox delivery or that a person read the message.
- `retry`: a rate limit, server failure or known concurrent idempotent request
  can retry the same job/key/payload. The database caps attempts at eight and the
  retry window at 23 hours; reaching either creates a held failure.
- `failed`: a definite rejection or configuration problem requires review.
- `uncertain`: a timeout, lost connection, unknown conflict or malformed success
  might have reached the provider. Hold it for an operator; do not resend blindly.
- `unconfirmed` (worker response only): the finish receipt could not be verified.
  The worker stops. An expired database lease becomes an uncertainty hold.

The fixed provider key is `care-<job UUID>`. Keep the `creek-care-digest-v1` message
bytes stable for every retry. Resend documents a 24-hour idempotency retention
window, so the queue uses a shorter 23-hour limit. See [Resend idempotency
documentation](https://resend.com/docs/dashboard/emails/idempotency-keys).

There is a separate cap of 20 first-attempt care jobs per UTC day. Existing welcome
and initial-assignment jobs and their 80 first-attempt budget are unchanged.
These application limits do not establish available account quota: authentication
emails and other mail may also use the provider account.

## Source review and activation boundaries

The two proposed SQL files stay under `tools/care-reminders/migrations/`, outside
the exact twelve-file current deployment inventory. Their names were generated
by Supabase CLI 2.117.0. They must not be copied into an active migration manifest
or applied just to make a check pass.

Before activation, finish the Office owner/settings/held-job controls, confirm
the actual recipients, review this exact combined SQL and function bundle, and
rehearse one approved delivery with a real operator. Deployment, keys and a
schedule require the concrete activation step. No deacon account or invitation
is created here. This does not turn on any older deacon/attention/weekly-email
package, public newsletter, attendance monitor or phone push.

SQL claims recheck sources and permissions transactionally. An edit committed
after a claim may still race with the external email request; no database lock
is held while making a network call. The generic message and freshly authorized
Office destination limit that exposure. This is not an exactly-once delivery
guarantee.

## Tests

```sh
node --test tools/care-reminders/dispatch.test.mjs
```

All provider calls in these tests are injected mocks. The tests never send mail,
read secrets or access a hosted database. Database, integration and concurrency
checks are documented in the care-reminder server review.
