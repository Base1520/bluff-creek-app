-- OPTIONAL DRAFT: outside supabase/migrations; not part of staff-first setup.
-- Apply only after a separately approved public intake rollout and review.
-- Harden current Auth-row checks before restoring profile submission/update.
-- The public INVOKER calls the private DEFINER, so both need the same grant.
-- Existing own-profile isolation and staff-review behavior are unchanged.
-- This does not enable Auth signup, email delivery or any public page setting.
begin;

-- A valid access token alone does not establish that its account remains usable.
-- Recheck the Auth row for both direct RPCs and ordinary browser submissions.
create or replace function private.verified_connection_email()
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_email text;
begin
  if auth.uid() is null then
    raise exception 'Sign in with a verified email to connect with the church' using errcode = '42501';
  end if;
  select u.email into v_email from auth.users u
    where u.id = auth.uid() and u.email_confirmed_at is not null
      and not coalesce(u.is_anonymous, false) and nullif(btrim(u.email), '') is not null
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= now());
  if v_email is null then
    raise exception 'Sign in with a verified email to connect with the church' using errcode = '42501';
  end if;
  return v_email;
end $$;

revoke execute on function
  public.save_app_connection(text, text, text, text, boolean, text),
  private.save_app_connection(text, text, text, text, boolean, text)
from public, anon;

grant execute on function
  public.save_app_connection(text, text, text, text, boolean, text),
  private.save_app_connection(text, text, text, text, boolean, text)
to authenticated;

commit;
