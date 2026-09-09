/* Optional connection service. Keep blank until the backend and email flow are approved and verified.
   Use a browser-safe Supabase publishable key only. Never add a secret/service-role key.
   allowedOrigins must list exact approved origins; allowlist each origin's /connection.html
   in Supabase Auth URL configuration too. No wildcard or redirect query input is used. */
window.CREEK_CONNECTION_CONFIG = {
  supabaseUrl: '',
  publishableKey: '',
  allowedOrigins: []
};
