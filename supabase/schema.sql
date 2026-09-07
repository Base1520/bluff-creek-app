-- Creek Office initial schema. Run in a new Supabase project's SQL editor.
-- No member data, user email addresses, or credentials are included.

create extension if not exists pgcrypto;
create schema if not exists private;

create type public.staff_role as enum ('admin', 'editor', 'viewer');
create type public.contact_status as enum ('active', 'inactive', 'visitor');
create type public.document_category as enum ('policy', 'spreadsheet', 'form', 'minutes', 'ministry', 'other');
create type public.event_tag as enum ('Weekly', 'Monthly', 'Special');

create table public.staff_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role public.staff_role not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 160),
  tag public.event_tag not null default 'Special',
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  description text,
  -- Reserved metadata only: this private staff calendar does not publish a feed.
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  check (ends_at is null or ends_at >= starts_at)
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  status public.contact_status not null default 'active',
  household_name text,
  email text,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id)
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category public.document_category not null default 'other',
  description text,
  storage_path text not null unique,
  file_name text not null,
  mime_type text,
  size_bytes bigint not null check (size_bytes between 1 and 52428800),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  uploaded_by uuid not null references auth.users(id)
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  created_at timestamptz not null default now()
);

create or replace function private.current_staff_role()
returns public.staff_role
language sql
stable
security definer
set search_path = ''
as $$ select role from public.staff_roles where user_id = auth.uid() $$;

revoke all on function private.current_staff_role() from public;
grant usage on schema private to authenticated;
grant execute on function private.current_staff_role() to authenticated;

create or replace function private.touch_owned_record()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  if tg_op = 'INSERT' then new.created_by = auth.uid(); end if;
  new.updated_by = auth.uid();
  return new;
end $$;

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$ begin new.updated_at = now(); return new; end $$;

create or replace function private.record_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log(actor_id, action, entity_type, entity_id)
  values (auth.uid(), lower(tg_op), tg_table_name, coalesce(to_jsonb(new)->>'id', to_jsonb(old)->>'id'));
  return coalesce(new, old);
end $$;

revoke all on function private.touch_owned_record() from public;
revoke all on function private.touch_updated_at() from public;
revoke all on function private.record_audit() from public;

create trigger events_touch before insert or update on public.events for each row execute function private.touch_owned_record();
create trigger contacts_touch before insert or update on public.contacts for each row execute function private.touch_owned_record();
create trigger staff_roles_touch before update on public.staff_roles for each row execute function private.touch_updated_at();
create trigger documents_touch before update on public.documents for each row execute function private.touch_updated_at();
create trigger events_audit after insert or update or delete on public.events for each row execute function private.record_audit();
create trigger contacts_audit after insert or update or delete on public.contacts for each row execute function private.record_audit();
create trigger documents_audit after insert or update or delete on public.documents for each row execute function private.record_audit();

alter table public.staff_roles enable row level security;
alter table public.events enable row level security;
alter table public.contacts enable row level security;
alter table public.documents enable row level security;
alter table public.audit_log enable row level security;

revoke all on public.staff_roles, public.events, public.contacts, public.documents, public.audit_log from anon;
revoke all on public.staff_roles, public.events, public.contacts, public.documents, public.audit_log from authenticated;
grant select on public.staff_roles, public.events, public.contacts, public.documents, public.audit_log to authenticated;
grant insert, update, delete on public.events, public.contacts, public.documents to authenticated;

create policy staff_can_read_own_role on public.staff_roles for select to authenticated
using (user_id = (select auth.uid()));
create policy staff_can_read_events on public.events for select to authenticated
using (private.current_staff_role() is not null);
create policy editors_can_insert_events on public.events for insert to authenticated
with check (private.current_staff_role() in ('admin', 'editor'));
create policy editors_can_update_events on public.events for update to authenticated
using (private.current_staff_role() in ('admin', 'editor'))
with check (private.current_staff_role() in ('admin', 'editor'));
create policy editors_can_delete_events on public.events for delete to authenticated
using (private.current_staff_role() in ('admin', 'editor'));
create policy staff_can_read_contacts on public.contacts for select to authenticated
using (private.current_staff_role() is not null);
create policy editors_can_insert_contacts on public.contacts for insert to authenticated
with check (private.current_staff_role() in ('admin', 'editor'));
create policy editors_can_update_contacts on public.contacts for update to authenticated
using (private.current_staff_role() in ('admin', 'editor'))
with check (private.current_staff_role() in ('admin', 'editor'));
create policy editors_can_delete_contacts on public.contacts for delete to authenticated
using (private.current_staff_role() in ('admin', 'editor'));
create policy staff_can_read_documents on public.documents for select to authenticated
using (private.current_staff_role() is not null);
create policy editors_can_insert_documents on public.documents for insert to authenticated
with check (private.current_staff_role() in ('admin', 'editor')
  and uploaded_by = (select auth.uid())
  and split_part(storage_path, '/', 1) = (select auth.uid())::text);
create policy editors_can_update_documents on public.documents for update to authenticated
using (private.current_staff_role() in ('admin', 'editor'))
with check (private.current_staff_role() in ('admin', 'editor'));
create policy editors_can_delete_documents on public.documents for delete to authenticated
using (private.current_staff_role() in ('admin', 'editor'));
create policy staff_can_read_audit on public.audit_log for select to authenticated
using (private.current_staff_role() is not null);

insert into storage.buckets (id, name, public, file_size_limit)
values ('church-documents', 'church-documents', false, 52428800)
on conflict (id) do nothing;

create policy staff_can_read_files on storage.objects for select to authenticated
using (bucket_id = 'church-documents' and private.current_staff_role() is not null);
create policy editors_can_upload_files on storage.objects for insert to authenticated
with check (bucket_id = 'church-documents' and private.current_staff_role() in ('admin', 'editor')
  and split_part(name, '/', 1) = (select auth.uid())::text);
create policy editors_can_update_files on storage.objects for update to authenticated
using (bucket_id = 'church-documents' and private.current_staff_role() in ('admin', 'editor'))
with check (bucket_id = 'church-documents' and private.current_staff_role() in ('admin', 'editor'));
create policy editors_can_delete_files on storage.objects for delete to authenticated
using (bucket_id = 'church-documents' and private.current_staff_role() in ('admin', 'editor'));

create index events_starts_at_idx on public.events(starts_at);
create index contacts_name_idx on public.contacts(last_name, first_name);
create index documents_category_idx on public.documents(category);
create index audit_created_at_idx on public.audit_log(created_at desc);

-- After creating the first Auth user, assign that user as the first admin manually:
-- insert into public.staff_roles(user_id, role) values ('AUTH-USER-UUID', 'admin');
