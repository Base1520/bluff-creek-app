-- Apply after supabase/schema.sql. Private records only; no people or policy seed.
begin;

alter table public.contacts
  add column legacy_member_id text unique check (legacy_member_id is null or btrim(legacy_member_id) <> ''),
  add column membership_number text,
  add column middle_name text,
  add column preferred_name text,
  add column former_names text,
  add column address text,
  add column birth_date_text text,
  add column received_date_text text,
  add column baptism_date_text text,
  add column dismissal_date_text text,
  add column how_received text,
  add column reason_for_decrease text,
  add column needs_review boolean not null default false;

create table public.membership_history (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete restrict,
  event_type text not null check (btrim(event_type) <> ''),
  event_date date,
  date_text text,
  details text,
  source_label text,
  source_document_id uuid references public.documents(id) on delete restrict,
  corrects_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (id, contact_id),
  foreign key (corrects_id, contact_id) references public.membership_history(id, contact_id) on delete restrict,
  check (corrects_id is null or corrects_id <> id)
);

create table public.care_assignments (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null unique references public.contacts(id) on delete restrict,
  -- A display name is scheduling information, never an authorization grant.
  assigned_to text,
  cadence_days integer not null default 28 check (cadence_days between 1 and 365),
  started_on date not null default (now() at time zone 'America/Chicago')::date,
  paused boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id)
);

create table public.care_visits (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete restrict,
  visitor_name text not null check (btrim(visitor_name) <> ''),
  contacted_on date not null,
  method text not null default 'visit' check (method in ('call', 'visit', 'text', 'email', 'other')),
  outcome text not null default 'contacted' check (outcome in ('contacted', 'attempted')),
  notes text,
  next_contact_on date,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id)
);

create table public.guest_intakes (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null unique references public.contacts(id) on delete restrict,
  first_visit_on date,
  next_step text,
  status text not null default 'new' check (status in ('new', 'contacted', 'connected', 'closed')),
  follow_up_on date,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id)
);

create table public.care_guidelines (
  id text primary key default 'default' check (id = 'default'),
  body text not null check (btrim(body) <> ''),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id)
);

create function private.stamp_membership_owned_record()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at = now();
    new.created_by = auth.uid();
  else
    if new.id is distinct from old.id then
      raise exception 'Record identity cannot be changed' using errcode = '23514';
    end if;
    new.created_at = old.created_at;
    new.created_by = old.created_by;
  end if;
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end $$;

create function private.stamp_membership_entry()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.created_at = now();
  new.created_by = auth.uid();
  return new;
end $$;

create function private.reject_preserved_record_change()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'Preserved records cannot be changed or deleted; add a correction or mark the contact inactive'
    using errcode = '55000';
end $$;

create function private.keep_care_contact()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.contact_id is distinct from old.contact_id then
    raise exception 'A care record cannot be moved to another contact' using errcode = '23514';
  end if;
  return new;
end $$;

create function private.check_membership_correction()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  -- Require an already-existing entry for this contact, not an in-statement cycle.
  if new.corrects_id is not null and not exists (
    select 1 from public.membership_history h where h.id = new.corrects_id and h.contact_id = new.contact_id
  ) then
    raise exception 'Correction must reference an existing entry for the same contact' using errcode = '23503';
  end if;
  return new;
end $$;

revoke all on function private.stamp_membership_owned_record(), private.stamp_membership_entry(),
  private.reject_preserved_record_change(), private.keep_care_contact(), private.check_membership_correction()
  from public, anon, authenticated;

create trigger contacts_membership_stamp before insert or update on public.contacts
for each row execute function private.stamp_membership_owned_record();
drop policy editors_can_delete_contacts on public.contacts;
revoke delete, truncate on public.contacts from public, anon, authenticated;
create trigger contacts_preserve_delete before delete on public.contacts
for each row execute function private.reject_preserved_record_change();
create trigger contacts_preserve_truncate before truncate on public.contacts
for each statement execute function private.reject_preserved_record_change();

create trigger membership_history_stamp before insert on public.membership_history
for each row execute function private.stamp_membership_entry();
create trigger membership_history_correction before insert on public.membership_history
for each row execute function private.check_membership_correction();
create trigger membership_history_preserve before update or delete on public.membership_history
for each row execute function private.reject_preserved_record_change();
create trigger membership_history_preserve_truncate before truncate on public.membership_history
for each statement execute function private.reject_preserved_record_change();
create trigger care_visits_stamp before insert on public.care_visits
for each row execute function private.stamp_membership_entry();
create trigger care_visits_preserve before update or delete on public.care_visits
for each row execute function private.reject_preserved_record_change();
create trigger care_visits_preserve_truncate before truncate on public.care_visits
for each statement execute function private.reject_preserved_record_change();

create trigger care_assignments_stamp before insert or update on public.care_assignments
for each row execute function private.stamp_membership_owned_record();
create trigger care_assignments_contact before update on public.care_assignments
for each row execute function private.keep_care_contact();
create trigger guest_intakes_stamp before insert or update on public.guest_intakes
for each row execute function private.stamp_membership_owned_record();
create trigger guest_intakes_contact before update on public.guest_intakes
for each row execute function private.keep_care_contact();
create trigger care_guidelines_stamp before insert or update on public.care_guidelines
for each row execute function private.stamp_membership_owned_record();

create trigger membership_history_audit after insert on public.membership_history
for each row execute function private.record_audit();
create trigger care_visits_audit after insert on public.care_visits
for each row execute function private.record_audit();
create trigger care_assignments_audit after insert or update on public.care_assignments
for each row execute function private.record_audit();
create trigger guest_intakes_audit after insert or update on public.guest_intakes
for each row execute function private.record_audit();
create trigger care_guidelines_audit after insert or update on public.care_guidelines
for each row execute function private.record_audit();

alter table public.membership_history enable row level security;
alter table public.care_assignments enable row level security;
alter table public.care_visits enable row level security;
alter table public.guest_intakes enable row level security;
alter table public.care_guidelines enable row level security;

-- Explicit privileges also neutralize older projects' broad default privileges.
revoke all on public.membership_history, public.care_assignments, public.care_visits,
  public.guest_intakes, public.care_guidelines from public, anon, authenticated;
grant select on public.membership_history, public.care_assignments, public.care_visits,
  public.guest_intakes, public.care_guidelines to authenticated;
grant insert on public.membership_history, public.care_visits to authenticated;
grant insert, update on public.care_assignments, public.guest_intakes, public.care_guidelines to authenticated;

create policy editors_read_history on public.membership_history for select to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_append_history on public.membership_history for insert to authenticated
with check ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_read_visits on public.care_visits for select to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_append_visits on public.care_visits for insert to authenticated
with check ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_read_assignments on public.care_assignments for select to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_insert_assignments on public.care_assignments for insert to authenticated
with check ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_update_assignments on public.care_assignments for update to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'))
with check ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_read_intakes on public.guest_intakes for select to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_insert_intakes on public.guest_intakes for insert to authenticated
with check ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_update_intakes on public.guest_intakes for update to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'))
with check ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_read_guidelines on public.care_guidelines for select to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'));
create policy admins_insert_guidelines on public.care_guidelines for insert to authenticated
with check ((select private.current_staff_role()) = 'admin');
create policy admins_update_guidelines on public.care_guidelines for update to authenticated
using ((select private.current_staff_role()) = 'admin')
with check ((select private.current_staff_role()) = 'admin');

create policy protect_care_audit on public.audit_log as restrictive for select to authenticated
using (entity_type not in ('membership_history', 'care_assignments', 'care_visits', 'guest_intakes', 'care_guidelines')
  or (select private.current_staff_role()) in ('admin', 'editor'));

-- SECURITY DEFINER is needed to test references without exposing history to viewers.
-- These helpers remain outside the exposed public API schema and check current DB roles.
create function private.membership_source_locked(object_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case when coalesce(private.current_staff_role() in ('admin', 'editor'), false)
    then exists (select 1 from public.documents d join public.membership_history h
      on h.source_document_id = d.id where d.storage_path = object_path)
    else true end
$$;

create function private.can_read_membership_source(object_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case when private.current_staff_role() in ('admin', 'editor') then true
    -- Reserved upload path hides new images even before a history row is linked.
    when private.current_staff_role() = 'viewer' then split_part(object_path, '/', 2) <> 'membership-history' and not exists (
      select 1 from public.documents d join public.membership_history h
      on h.source_document_id = d.id where d.storage_path = object_path)
    else false end
$$;

revoke all on function private.membership_source_locked(text), private.can_read_membership_source(text)
  from public, anon, authenticated;
grant execute on function private.membership_source_locked(text), private.can_read_membership_source(text)
  to authenticated;

-- Lock metadata too: changing storage_path would otherwise unlock the original blob.
create function private.preserve_membership_source_document()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.membership_history h where h.source_document_id = old.id) then
    raise exception 'A referenced membership source document must be preserved' using errcode = '55000';
  end if;
  return coalesce(new, old);
end $$;
revoke all on function private.preserve_membership_source_document() from public, anon, authenticated;
create trigger documents_membership_preserve before update or delete on public.documents
for each row execute function private.preserve_membership_source_document();

create policy protect_membership_source_metadata on public.documents as restrictive for select to authenticated
using (private.can_read_membership_source(storage_path));
create policy protect_membership_source_reads on storage.objects as restrictive for select to authenticated
using (bucket_id <> 'church-documents' or private.can_read_membership_source(name));
create policy protect_membership_source_inserts on storage.objects as restrictive for insert to authenticated
with check (bucket_id <> 'church-documents' or not private.membership_source_locked(name));
create policy protect_membership_source_updates on storage.objects as restrictive for update to authenticated
using (bucket_id <> 'church-documents' or not private.membership_source_locked(name))
with check (bucket_id <> 'church-documents' or not private.membership_source_locked(name));
create policy protect_membership_source_deletes on storage.objects as restrictive for delete to authenticated
using (bucket_id <> 'church-documents' or not private.membership_source_locked(name));

create index membership_history_contact_date_idx on public.membership_history(contact_id, created_at desc);
create index membership_history_source_idx on public.membership_history(source_document_id) where source_document_id is not null;
create index membership_history_correction_idx on public.membership_history(corrects_id) where corrects_id is not null;
create index care_visits_contact_date_idx on public.care_visits(contact_id, contacted_on desc);
create index guest_intakes_follow_up_idx on public.guest_intakes(follow_up_on) where status <> 'closed';

commit;
