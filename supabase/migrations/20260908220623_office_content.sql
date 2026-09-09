-- Apply after schema.sql and 20260907_membership_care.sql.
-- Private office drafts only. No public feed, intake endpoint, or seeded content.
begin;

-- Deliberately supports ordinary HTTPS domain links, not every possible URI.
-- Pure syntax validation: no network requests and no destination safety claim.
create function private.valid_office_deck_url(value text)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare
  parts text[];
  hostname text;
  label text;
  port_text text;
begin
  if value is null then return true; end if;
  if char_length(value) not between 1 and 4096
    or value ~ '[[:space:][:cntrl:]]' or position(chr(92) in value) > 0 then
    return false;
  end if;
  parts = regexp_match(value, '^https://([^/?#]+)([/?#].*)?$', 'i');
  if parts is null or parts[1] !~ '^[A-Za-z0-9.-]+(:[0-9]{1,5})?$' then return false; end if;
  hostname = split_part(parts[1], ':', 1);
  port_text = split_part(parts[1], ':', 2);
  if char_length(hostname) not between 1 and 253 then return false; end if;
  foreach label in array string_to_array(hostname, '.') loop
    if label !~ '^([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])$' then return false; end if;
  end loop;
  if port_text <> '' and port_text::integer not between 1 and 65535 then return false; end if;
  return true;
end $$;
revoke all on function private.valid_office_deck_url(text) from public, anon, authenticated;
grant execute on function private.valid_office_deck_url(text) to authenticated;

create table public.office_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 160 and title ~ '[^[:space:]]'),
  body text not null check (char_length(body) between 1 and 10000 and body ~ '[^[:space:]]'),
  status text not null default 'draft' check (status in ('draft', 'ready', 'archived')),
  starts_on date,
  ends_on date,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id),
  check (starts_on is null or ends_on is null or ends_on >= starts_on)
);

create table public.committee_contacts (
  id uuid primary key default gen_random_uuid(),
  committee_name text not null check (char_length(committee_name) between 1 and 160 and committee_name ~ '[^[:space:]]'),
  contact_name text not null check (char_length(contact_name) between 1 and 160 and contact_name ~ '[^[:space:]]'),
  role_label text,
  email text,
  phone text,
  term_start date,
  term_end date,
  notes text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id),
  check (term_start is null or term_end is null or term_end >= term_start)
);

create table public.sunday_slides (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 160 and title ~ '[^[:space:]]'),
  service_date date not null,
  status text not null default 'draft' check (status in ('draft', 'ready', 'archived')),
  deck_url text check (private.valid_office_deck_url(deck_url)),
  document_id uuid references public.documents(id) on delete restrict,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id),
  check (status <> 'ready' or deck_url is not null or document_id is not null)
);

create table public.office_prayer_requests (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (char_length(display_name) between 1 and 160 and display_name ~ '[^[:space:]]'),
  request_text text not null check (char_length(request_text) between 1 and 10000 and request_text ~ '[^[:space:]]'),
  care_notes text,
  status text not null default 'active' check (status in ('active', 'answered', 'archived')),
  share_scope text not null default 'staff_only' check (share_scope in ('staff_only', 'prayer_team', 'church')),
  sharing_approved boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id),
  check (share_scope = 'staff_only' or sharing_approved)
);

create trigger office_announcements_stamp before insert or update on public.office_announcements
for each row execute function private.stamp_membership_owned_record();
create trigger committee_contacts_stamp before insert or update on public.committee_contacts
for each row execute function private.stamp_membership_owned_record();
create trigger sunday_slides_stamp before insert or update on public.sunday_slides
for each row execute function private.stamp_membership_owned_record();
create trigger office_prayer_requests_stamp before insert or update on public.office_prayer_requests
for each row execute function private.stamp_membership_owned_record();

create trigger office_announcements_audit after insert or update on public.office_announcements
for each row execute function private.record_audit();
create trigger committee_contacts_audit after insert or update on public.committee_contacts
for each row execute function private.record_audit();
create trigger sunday_slides_audit after insert or update on public.sunday_slides
for each row execute function private.record_audit();
create trigger office_prayer_requests_audit after insert or update on public.office_prayer_requests
for each row execute function private.record_audit();

alter table public.office_announcements enable row level security;
alter table public.committee_contacts enable row level security;
alter table public.sunday_slides enable row level security;
alter table public.office_prayer_requests enable row level security;
revoke all on public.office_announcements, public.committee_contacts, public.sunday_slides,
  public.office_prayer_requests from public, anon, authenticated;
grant select, insert, update on public.office_announcements, public.committee_contacts,
  public.sunday_slides, public.office_prayer_requests to authenticated;

create policy editors_read_announcements on public.office_announcements for select to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_insert_announcements on public.office_announcements for insert to authenticated
with check ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_update_announcements on public.office_announcements for update to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'))
with check ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_read_committee_contacts on public.committee_contacts for select to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_insert_committee_contacts on public.committee_contacts for insert to authenticated
with check ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_update_committee_contacts on public.committee_contacts for update to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'))
with check ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_read_sunday_slides on public.sunday_slides for select to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_insert_sunday_slides on public.sunday_slides for insert to authenticated
with check ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_update_sunday_slides on public.sunday_slides for update to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'))
with check ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_read_office_prayer on public.office_prayer_requests for select to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_insert_office_prayer on public.office_prayer_requests for insert to authenticated
with check ((select private.current_staff_role()) in ('admin', 'editor'));
create policy editors_update_office_prayer on public.office_prayer_requests for update to authenticated
using ((select private.current_staff_role()) in ('admin', 'editor'))
with check ((select private.current_staff_role()) in ('admin', 'editor'));

-- AND with the existing staff and care-audit policies, retaining their protection.
create policy protect_office_content_audit on public.audit_log as restrictive for select to authenticated
using (entity_type not in ('office_announcements', 'committee_contacts', 'sunday_slides', 'office_prayer_requests')
  or (select private.current_staff_role()) in ('admin', 'editor'));

create index office_announcements_status_date_idx on public.office_announcements(status, starts_on);
create index committee_contacts_status_name_idx on public.committee_contacts(status, committee_name);
create index sunday_slides_service_date_idx on public.sunday_slides(service_date desc);
create index sunday_slides_document_idx on public.sunday_slides(document_id) where document_id is not null;
create index office_prayer_requests_status_date_idx on public.office_prayer_requests(status, updated_at desc);

commit;
