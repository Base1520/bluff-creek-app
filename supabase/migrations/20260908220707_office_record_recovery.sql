-- Base office record recovery. Apply after all prior documented office migrations.
-- Generated locally by the Supabase CLI; no hosted database or account is changed here.
begin;

-- Refuse partial setup rather than advertising modules whose preceding schema is missing.
do $$
declare v_table text;
begin
  foreach v_table in array array[
    'staff_roles', 'events', 'contacts', 'documents', 'audit_log', 'membership_history',
    'care_assignments', 'care_visits', 'guest_intakes', 'care_guidelines',
    'office_announcements', 'committee_contacts', 'sunday_slides', 'office_prayer_requests',
    'app_connections', 'leader_followups', 'leader_followup_contacts'
  ] loop
    if to_regclass('public.' || v_table) is null then
      raise exception 'Apply all preceding office migrations before office record recovery' using errcode = '55000';
    end if;
  end loop;
end $$;

alter table public.events
  add column version integer not null default 1 check (version > 0),
  add column is_archived boolean not null default false,
  add column archived_at timestamptz;
alter table public.contacts add column version integer not null default 1 check (version > 0);
alter table public.documents add column version integer not null default 1 check (version > 0);
alter table public.care_assignments add column version integer not null default 1 check (version > 0);
alter table public.guest_intakes add column version integer not null default 1 check (version > 0);
alter table public.care_guidelines add column version integer not null default 1 check (version > 0);
alter table public.office_announcements add column version integer not null default 1 check (version > 0);
alter table public.committee_contacts add column version integer not null default 1 check (version > 0);
alter table public.sunday_slides add column version integer not null default 1 check (version > 0);
alter table public.office_prayer_requests add column version integer not null default 1 check (version > 0);

-- Stable client-generated INSERT UUIDs remain allowed by the existing table grants.
-- On UPDATE, record identity and original creation metadata cannot be replaced.
-- Versions are server-controlled; clients filter writes by their displayed version.
create function private.stamp_office_record_version()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := now();
    if tg_table_name in ('events', 'contacts') then
      new.created_by := auth.uid();
    elsif tg_table_name = 'documents' then
      new.uploaded_by := auth.uid();
    end if;
  else
    if new.id is distinct from old.id then
      raise exception 'Office record identity cannot be changed' using errcode = '23514';
    end if;
    new.version := old.version + 1;
    new.created_at := old.created_at;
    if tg_table_name in ('events', 'contacts') then
      new.created_by := old.created_by;
    elsif tg_table_name = 'documents' then
      new.uploaded_by := old.uploaded_by;
    end if;
  end if;
  new.updated_at := now();
  if tg_table_name in ('events', 'contacts') then
    new.updated_by := auth.uid();
  end if;
  if tg_table_name = 'events' then
    if not new.is_archived then
      new.archived_at := null;
    elsif tg_op = 'INSERT' then
      new.archived_at := now();
    elsif not old.is_archived then
      new.archived_at := now();
    else
      new.archived_at := old.archived_at;
    end if;
  end if;
  return new;
end $$;
revoke all on function private.stamp_office_record_version() from public, anon, authenticated;
create trigger events_recovery_stamp before insert or update on public.events
for each row execute function private.stamp_office_record_version();
create trigger contacts_recovery_stamp before insert or update on public.contacts
for each row execute function private.stamp_office_record_version();
create trigger documents_recovery_stamp before insert or update on public.documents
for each row execute function private.stamp_office_record_version();
create trigger care_assignments_recovery_stamp before insert or update on public.care_assignments
for each row execute function private.stamp_office_record_version();
create trigger guest_intakes_recovery_stamp before insert or update on public.guest_intakes
for each row execute function private.stamp_office_record_version();
create trigger care_guidelines_recovery_stamp before insert or update on public.care_guidelines
for each row execute function private.stamp_office_record_version();
create trigger office_announcements_recovery_stamp before insert or update on public.office_announcements
for each row execute function private.stamp_office_record_version();
create trigger committee_contacts_recovery_stamp before insert or update on public.committee_contacts
for each row execute function private.stamp_office_record_version();
create trigger sunday_slides_recovery_stamp before insert or update on public.sunday_slides
for each row execute function private.stamp_office_record_version();
create trigger office_prayer_requests_recovery_stamp before insert or update on public.office_prayer_requests
for each row execute function private.stamp_office_record_version();

create function private.reject_event_removal()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'Archive or restore an event instead of deleting it' using errcode = '55000';
end $$;
revoke all on function private.reject_event_removal() from public, anon, authenticated;
drop policy editors_can_delete_events on public.events;
revoke delete, truncate on public.events from public, anon, authenticated;
create trigger events_preserve_delete before delete on public.events
for each row execute function private.reject_event_removal();
create trigger events_preserve_truncate before truncate on public.events
for each statement execute function private.reject_event_removal();
create index events_archive_starts_at_idx on public.events(is_archived, starts_at);

-- A schema/role handshake only: this does not assert hosted Storage, email, backup,
-- connectivity or a complete RLS/security audit. The caller gets no person/account IDs.
create function public.office_readiness()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role public.staff_role;
begin
  v_role := private.current_staff_role();
  if auth.uid() is null or v_role is null then
    raise exception 'Current staff access is required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'schema_revision', '20260907174301',
    'staff_role', v_role,
    'supported_modules', case when v_role = 'viewer' then
      jsonb_build_array('events', 'contacts', 'documents', 'activity')
    else jsonb_build_array('events', 'contacts', 'documents', 'activity',
      'membership', 'care', 'office_content', 'app_signups', 'leader_followups') end
  );
end $$;
revoke all on function public.office_readiness() from public, anon, authenticated;
grant execute on function public.office_readiness() to authenticated;

commit;
