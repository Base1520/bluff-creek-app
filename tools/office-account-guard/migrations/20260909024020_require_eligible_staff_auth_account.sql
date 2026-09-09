-- Review-only follow-up to the seven applied office migrations.
-- This file is intentionally outside the active supabase/migrations directory.
-- Do not apply it as a workaround for a blocked hosted action.
begin;

create or replace function private.current_staff_role()
returns public.staff_role
language sql
stable
security definer
set search_path = ''
as $$
  select staff.role
  from public.staff_roles as staff
  join auth.users as account on account.id = staff.user_id
  where staff.user_id = auth.uid()
    and account.is_anonymous is false
    and account.email_confirmed_at is not null
    and nullif(btrim(account.email), '') is not null
    and account.deleted_at is null
    and (account.banned_until is null or account.banned_until <= now())
$$;

-- CREATE OR REPLACE retains the existing owner and execution privileges.
-- No policy, role assignment, account, public intake grant or record changes.
commit;
