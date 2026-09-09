-- Staff-first rollout: pause new public app profiles and profile updates.
-- This changes only browser-role EXECUTE privileges for the submission pair.
-- Existing own-profile reads, staff review, records and Auth settings are unchanged.
-- Reopening intake requires a separately reviewed tracked migration and rehearsal;
-- configuring a public page is not permission to restore these grants.
begin;

revoke execute on function
  public.save_app_connection(text, text, text, text, boolean, text),
  private.save_app_connection(text, text, text, text, boolean, text)
from public, anon, authenticated;

commit;
