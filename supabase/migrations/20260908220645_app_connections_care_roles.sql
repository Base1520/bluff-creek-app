-- Prepared locally only. Apply after schema.sql and both earlier 20260907 migrations.
-- Created with Supabase CLI migration new; no hosted database has been changed.
-- No Auth users, staff grants, people, or notification deliveries are seeded here.
begin;

alter table public.care_assignments
  drop constraint care_assignments_contact_id_key,
  add column care_role text not null default 'deacon'
    check (care_role in ('deacon', 'sunday_school', 'welcome', 'pastoral', 'custom')),
  add column cadence_months integer check (cadence_months between 1 and 12),
  add column first_due_on date,
  add column one_time boolean not null default false,
  add constraint care_assignments_contact_role_key unique (contact_id, care_role);

-- Existing history receives the original deacon role without rewriting its content.
alter table public.care_visits
  add column care_role text not null default 'deacon'
    check (care_role in ('deacon', 'sunday_school', 'welcome', 'pastoral', 'custom'));

create function private.keep_care_role()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.care_role is distinct from old.care_role then
    raise exception 'A care plan role cannot be changed; pause this plan and create the other role' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.keep_care_role() from public, anon, authenticated;
create trigger care_assignments_role before update on public.care_assignments
for each row execute function private.keep_care_role();
create index care_visits_contact_role_date_idx on public.care_visits(contact_id, care_role, contacted_on desc);

create table public.app_connections (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete restrict,
  first_name text not null check (char_length(btrim(first_name)) between 1 and 100),
  last_name text not null default '' check (char_length(last_name) <= 100),
  -- Auth owns the email. Public requests have no email or user-ID argument.
  email text not null check (char_length(btrim(email)) between 3 and 320),
  phone text check (char_length(phone) <= 32),
  preferred_contact text not null check (preferred_contact in ('email', 'phone', 'text')),
  contact_permission boolean not null check (contact_permission),
  sunday_school text check (char_length(sunday_school) <= 160),
  version integer not null default 1 check (version > 0),
  reviewed_version integer check (reviewed_version between 1 and version),
  contact_id uuid references public.contacts(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'archived')),
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  staff_notes text check (char_length(staff_notes) <= 2000),
  check (preferred_contact = 'email' or nullif(btrim(phone), '') is not null),
  check (status <> 'reviewed' or (contact_id is not null and reviewed_version = version and reviewed_at is not null and reviewed_by is not null))
);

alter table public.app_connections enable row level security;
-- Default privileges on old projects must not turn this intake into a public table.
revoke all on public.app_connections from public, anon, authenticated;
grant select on public.app_connections to authenticated;
create policy editors_read_app_connections on public.app_connections for select to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'));
create index app_connections_pending_idx on public.app_connections(updated_at desc) where status = 'pending';
create index app_connections_contact_idx on public.app_connections(contact_id) where contact_id is not null;
create index app_connections_reviewed_by_idx on public.app_connections(reviewed_by) where reviewed_by is not null;

create trigger app_connections_audit after insert or update on public.app_connections
for each row execute function private.record_audit();
create policy protect_app_connection_audit on public.audit_log as restrictive for select to authenticated
using (entity_type <> 'app_connections' or (select private.current_staff_role()) in ('admin', 'editor'));

-- These private helpers deliberately bypass table RLS for narrowly scoped operations.
-- Every helper checks the current Auth user or live staff role; none trusts JWT metadata.
create function private.verified_connection_email()
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_email text;
begin
  if auth.uid() is null then
    raise exception 'Sign in with a verified email to connect with the church' using errcode = '42501';
  end if;
  select u.email into v_email from auth.users u
    where u.id = auth.uid() and u.email_confirmed_at is not null
      and not coalesce(u.is_anonymous, false) and nullif(btrim(u.email), '') is not null;
  if v_email is null then
    raise exception 'Sign in with a verified email to connect with the church' using errcode = '42501';
  end if;
  return v_email;
end $$;

create function private.save_app_connection(
  p_first_name text, p_last_name text, p_phone text, p_preferred_contact text,
  p_contact_permission boolean, p_sunday_school text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
  v_row public.app_connections%rowtype;
  v_first text := btrim(p_first_name);
  v_last text := coalesce(btrim(p_last_name), '');
  v_phone text := nullif(btrim(p_phone), '');
  v_school text := nullif(btrim(p_sunday_school), '');
begin
  v_email := private.verified_connection_email();
  if v_first is null or char_length(v_first) not between 1 and 100
    or char_length(v_last) > 100 or char_length(v_phone) > 32 or char_length(v_school) > 160
    or p_preferred_contact is null or p_preferred_contact not in ('email', 'phone', 'text')
    or p_contact_permission is distinct from true
    or (p_preferred_contact in ('phone', 'text') and v_phone is null) then
    raise exception 'Check the profile fields and permission to contact you' using errcode = '22023';
  end if;
  insert into public.app_connections as connection
    (auth_user_id, first_name, last_name, email, phone, preferred_contact, contact_permission, sunday_school)
  values (auth.uid(), v_first, v_last, v_email, v_phone, p_preferred_contact, true, v_school)
  on conflict (auth_user_id) do update set
    first_name = excluded.first_name, last_name = excluded.last_name, email = excluded.email,
    phone = excluded.phone, preferred_contact = excluded.preferred_contact,
    contact_permission = true, sunday_school = excluded.sunday_school,
    version = connection.version + 1, status = 'pending', updated_at = now()
  returning * into v_row;
  -- The previous staff review, person link, original signup date and private notes stay intact.
  return jsonb_build_object('id', v_row.id, 'version', v_row.version);
end $$;

create function private.get_my_app_connection()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_profile jsonb;
  v_email text;
begin
  v_email := private.verified_connection_email();
  select jsonb_build_object(
    'id', c.id, 'first_name', c.first_name, 'last_name', c.last_name, 'email', v_email,
    'phone', c.phone, 'preferred_contact', c.preferred_contact, 'contact_permission', c.contact_permission,
    'sunday_school', c.sunday_school, 'version', c.version, 'submitted_at', c.submitted_at, 'updated_at', c.updated_at
  ) into v_profile from public.app_connections c where c.auth_user_id = auth.uid();
  return v_profile;
end $$;

create function private.review_app_connection(
  p_id uuid, p_version integer, p_contact_id uuid, p_create_person boolean,
  p_staff_notes text, p_welcome_owner text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row public.app_connections%rowtype;
  v_contact_id uuid;
  v_owner text := nullif(btrim(p_welcome_owner), '');
  v_notes text := nullif(btrim(p_staff_notes), '');
  v_signup_date date;
begin
  if auth.uid() is null or not coalesce(private.current_staff_role() in ('admin', 'editor'), false) then
    raise exception 'Only authorized office staff may review app connections' using errcode = '42501';
  end if;
  select * into v_row from public.app_connections where id = p_id for update;
  if not found then
    raise exception 'Connection is not available' using errcode = 'P0002';
  end if;
  if p_version is null or p_version <> v_row.version then
    raise exception 'This profile has changed. Reload and review the latest version' using errcode = '40001';
  end if;
  -- A network retry must not create another person, welcome plan or audit event.
  if v_row.status = 'reviewed' and v_row.reviewed_version = v_row.version then
    if p_create_person = false and p_contact_id is distinct from v_row.contact_id then
      raise exception 'This signup was already reviewed for another person. Reload before continuing' using errcode = '40001';
    end if;
    return jsonb_build_object('id', v_row.id, 'version', v_row.version, 'contact_id', v_row.contact_id,
      'status', 'reviewed', 'already_reviewed', true);
  end if;
  if p_create_person is null or (p_create_person and p_contact_id is not null)
    or (not p_create_person and p_contact_id is null)
    or char_length(v_notes) > 2000 or char_length(v_owner) > 120 then
    raise exception 'Choose one existing person or create one new visitor; check review field lengths' using errcode = '22023';
  end if;
  if v_row.contact_id is not null and (p_create_person or p_contact_id is distinct from v_row.contact_id) then
    raise exception 'This signup is already linked to a person. Review updates against that same person' using errcode = '22023';
  end if;
  if p_create_person then
    insert into public.contacts(first_name, last_name, email, phone, status, needs_review)
    values (v_row.first_name, v_row.last_name, v_row.email, v_row.phone, 'visitor', true)
    returning id into v_contact_id;
  else
    select id into v_contact_id from public.contacts where id = p_contact_id for update;
    if not found then
      raise exception 'The selected person is not available' using errcode = '23503';
    end if;
    -- Linking a signup never overwrites existing membership, contact or history fields.
  end if;
  v_signup_date := (v_row.submitted_at at time zone 'America/Chicago')::date;
  insert into public.care_assignments
    (contact_id, care_role, assigned_to, cadence_days, started_on, first_due_on, one_time)
  values (v_contact_id, 'welcome', v_owner, 2, v_signup_date, v_signup_date + 2, true)
  on conflict (contact_id, care_role) do nothing;
  update public.app_connections set contact_id = v_contact_id, status = 'reviewed',
    reviewed_version = version, reviewed_at = now(), reviewed_by = auth.uid(), staff_notes = v_notes,
    updated_at = now() where id = v_row.id;
  return jsonb_build_object('id', v_row.id, 'version', v_row.version, 'contact_id', v_contact_id, 'status', 'reviewed');
end $$;

-- Public API functions run with caller privileges; the privileged work stays private.
create function public.save_app_connection(
  p_first_name text, p_last_name text, p_phone text, p_preferred_contact text,
  p_contact_permission boolean, p_sunday_school text
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.save_app_connection(p_first_name, p_last_name, p_phone, p_preferred_contact, p_contact_permission, p_sunday_school)
$$;
create function public.get_my_app_connection()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.get_my_app_connection()
$$;
create function public.review_app_connection(
  p_id uuid, p_version integer, p_contact_id uuid, p_create_person boolean,
  p_staff_notes text, p_welcome_owner text
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.review_app_connection(p_id, p_version, p_contact_id, p_create_person, p_staff_notes, p_welcome_owner)
$$;

revoke all on function private.verified_connection_email() from public, anon, authenticated;
revoke all on function private.save_app_connection(text,text,text,text,boolean,text),
  private.get_my_app_connection(), private.review_app_connection(uuid,integer,uuid,boolean,text,text),
  public.save_app_connection(text,text,text,text,boolean,text), public.get_my_app_connection(),
  public.review_app_connection(uuid,integer,uuid,boolean,text,text) from public, anon, authenticated;
grant execute on function private.save_app_connection(text,text,text,text,boolean,text),
  private.get_my_app_connection(), private.review_app_connection(uuid,integer,uuid,boolean,text,text),
  public.save_app_connection(text,text,text,text,boolean,text), public.get_my_app_connection(),
  public.review_app_connection(uuid,integer,uuid,boolean,text,text) to authenticated;

commit;
