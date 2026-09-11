import { createGuestSheetHandler } from './handler.mjs';
// The only caller credential is this projection-specific secret. The service key
// remains in the Edge environment and is never sent to Google or returned.
Deno.serve(createGuestSheetHandler({
  secret: Deno.env.get('CREEK_GUEST_SHEET_SECRET'),
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  projectURL: Deno.env.get('SUPABASE_URL'),
}));
