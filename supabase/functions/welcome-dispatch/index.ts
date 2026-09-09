import { createWelcomeHandler } from './handler.mjs';

// This worker belongs only to the reviewed church project. Never use browser config
// for service credentials, recipients, email content, or a scheduled-job secret.
const project = Deno.env.get('SUPABASE_URL');
Deno.serve(createWelcomeHandler({
  projectURL: project === 'https://xzfeumdonxeodqhfirjr.supabase.co' ? project : '',
  publishableKey: Deno.env.get('CREEK_PUBLIC_KEY'),
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  resendKey: Deno.env.get('CREEK_WELCOME_RESEND_KEY'),
  jobSecret: Deno.env.get('CREEK_WELCOME_JOB_SECRET'),
}));
