import { createCareReminderHandler, resolveServiceKey } from './handler.mjs';

// Source-only: no secret configuration, deployment or schedule is activated by
// this file. The database settings also default to disabled and no recipients.
Deno.serve(createCareReminderHandler({
  projectURL: Deno.env.get('SUPABASE_URL'),
  serviceKey: resolveServiceKey(Deno.env.get('SUPABASE_SECRET_KEYS'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')),
  resendKey: Deno.env.get('CREEK_CARE_RESEND_KEY'),
  jobSecret: Deno.env.get('CREEK_CARE_JOB_SECRET'),
}));
