-- OPTIONAL REVIEW PACKAGE: generated with Supabase CLI 2.117.0 migration new.
-- Outside the active eight-migration directory. No accounts, mail or hosted changes.
begin;

alter table public.app_connections
  add column visit_status text not null default 'not_yet' check (visit_status in ('not_yet','first_visit','returning')),
  add column first_visit_on date,
  add column staff_visit_on date,
  add column follow_up_on date,
  add column follow_up_status text not null default 'new' check (follow_up_status in ('new','contacted','connected','closed')),
  add column welcome_owner text check (char_length(welcome_owner) <= 120),
  add column staff_version integer not null default 1 check (staff_version > 0),
  -- Existing registrations have no newly authorized email job. Never backfill mail.
  add column welcome_email_status text not null default 'attention' check (welcome_email_status in ('queued','sending','sent','attention'));
alter table public.app_connections alter column welcome_email_status set default 'queued';

alter table public.office_prayer_requests
  add column source text not null default 'office' check (source in ('office','app')),
  add column submitted_auth_user_id uuid references auth.users(id) on delete restrict,
  add column contact_text text check (char_length(contact_text) <= 320),
  add constraint prayer_app_origin check ((source='app' and submitted_auth_user_id is not null) or (source='office' and submitted_auth_user_id is null));
create index office_prayer_submitted_account_idx on public.office_prayer_requests(submitted_auth_user_id) where submitted_auth_user_id is not null;

create table private.app_intake_receipts (
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  kind text not null check (kind in ('guest','prayer')),
  request_id uuid not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (auth_user_id,kind,request_id)
);
create index app_intake_receipts_quota_idx on private.app_intake_receipts(auth_user_id,kind,created_at);
create table private.app_welcome_outbox (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null unique references public.app_connections(id) on delete restrict,
  recipient text not null check (char_length(recipient) between 3 and 320 and recipient !~ '[[:cntrl:][:space:]]'),
  recipient_key text not null unique check (recipient_key=lower(btrim(recipient))),
  first_name text not null check (char_length(first_name) between 1 and 100),
  template_version text not null default 'creek-welcome-v1' check (template_version='creek-welcome-v1'),
  status text not null default 'queued' check (status in ('queued','sending','sent','attention')),
  created_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  provider_id uuid,
  error_code text,
  check ((status='sending' and lease_token is not null and lease_until is not null) or (status<>'sending' and lease_token is null and lease_until is null)),
  check ((first_attempt_at is null and attempts=0) or (first_attempt_at is not null and attempts>0)),
  check (status<>'sent' or provider_id is not null)
);
create index app_welcome_claim_idx on private.app_welcome_outbox(status,next_attempt_at,lease_until);
create table private.app_welcome_links (
  registration_id uuid primary key references public.app_connections(id) on delete restrict,
  outbox_id uuid not null references private.app_welcome_outbox(id) on delete restrict
);
create index app_welcome_links_job_idx on private.app_welcome_links(outbox_id);
create table private.app_welcome_daily_quota (
  utc_day date primary key,
  first_attempts integer not null default 0 check (first_attempts between 0 and 80)
);

alter table private.app_intake_receipts enable row level security;
alter table private.app_welcome_outbox enable row level security;
alter table private.app_welcome_links enable row level security;
alter table private.app_welcome_daily_quota enable row level security;
revoke all on private.app_intake_receipts,private.app_welcome_outbox,private.app_welcome_links,private.app_welcome_daily_quota from public,anon,authenticated,service_role;

-- Self-reported email eligibility is separate from the unchanged staff helper.
create function private.app_account_email()
returns text language plpgsql stable security definer set search_path='' as $$
declare v_email text;
begin
  select btrim(u.email) into v_email from auth.users u
  where u.id=auth.uid() and not coalesce(u.is_anonymous,false) and u.deleted_at is null
    and (u.banned_until is null or u.banned_until<=now())
    and char_length(btrim(u.email)) between 3 and 320 and u.email !~ '[[:cntrl:][:space:]]';
  if v_email is null then raise exception 'APP_ACCOUNT_REQUIRED' using errcode='42501'; end if;
  return v_email;
end $$;
create function private.lock_app_account()
returns text language plpgsql security definer set search_path='' as $$
declare v_email text;
begin
  -- This current-row lock serializes per-account receipts and quotas, and rechecks
  -- eligibility after a concurrent account update. No user-selected identity.
  select btrim(u.email) into v_email from auth.users u
  where u.id=auth.uid() and not coalesce(u.is_anonymous,false) and u.deleted_at is null
    and (u.banned_until is null or u.banned_until<=clock_timestamp())
    and char_length(btrim(u.email)) between 3 and 320 and u.email !~ '[[:cntrl:][:space:]]'
  for update;
  if v_email is null then raise exception 'APP_ACCOUNT_REQUIRED' using errcode='42501'; end if;
  return v_email;
end $$;
create function private.app_intake_date(p_value jsonb)
returns date language plpgsql immutable security invoker set search_path='' as $$
declare v_date date;
begin
  if p_value is null or p_value='null'::jsonb then return null; end if;
  if jsonb_typeof(p_value)<>'string' or (p_value#>>'{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'INVALID_INTAKE_DATE' using errcode='22023';
  end if;
  begin v_date := (p_value#>>'{}')::date;
  exception when others then raise exception 'INVALID_INTAKE_DATE' using errcode='22023'; end;
  if to_char(v_date,'YYYY-MM-DD')<>(p_value#>>'{}') then raise exception 'INVALID_INTAKE_DATE' using errcode='22023'; end if;
  return v_date;
end $$;

-- Optional self-reported profile details. Omitted update fields are preserved.
alter table public.app_connections
 add column birth_date date,
 add column membership_status text not null default 'unsure' check(membership_status in('member','regular_attender','guest','exploring','unsure')),
 add column address_line1 text check(char_length(address_line1)<=160),
 add column address_line2 text check(char_length(address_line2)<=160),
 add column city text check(char_length(city)<=100),
 add column state_region text check(char_length(state_region)<=100),
 add column postal_code text check(char_length(postal_code)<=20),
 add column family_members jsonb not null default '[]'::jsonb check(jsonb_typeof(family_members)='array' and jsonb_array_length(family_members)<=20);

create function private.app_intake_birth_date(p_value jsonb)
returns date language plpgsql stable security invoker set search_path='' as $$
declare v_date date;
begin
 v_date:=private.app_intake_date(p_value);
 if v_date>(now() at time zone 'America/Chicago')::date then raise exception 'INVALID_BIRTH_DATE' using errcode='22023';end if;
 return v_date;
end $$;
create function private.app_profile_details(p_profile jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_details jsonb:='{}';v_key text;v_value text;v_limit integer;v_family jsonb:='[]';v_member jsonb;v_first text;v_last text;v_birth date;
begin
 if p_profile?'birth_date' then v_details:=v_details||jsonb_build_object('birth_date',private.app_intake_birth_date(p_profile->'birth_date'));end if;
 if p_profile?'membership_status' then
  if jsonb_typeof(p_profile->'membership_status')<>'string' or p_profile->>'membership_status' not in('member','regular_attender','guest','exploring','unsure') then raise exception 'INVALID_MEMBERSHIP_STATUS' using errcode='22023';end if;
  v_details:=v_details||jsonb_build_object('membership_status',p_profile->>'membership_status');
 end if;
 foreach v_key in array array['address_line1','address_line2','city','state_region','postal_code'] loop
  if p_profile?v_key then
   if jsonb_typeof(p_profile->v_key) not in('string','null') then raise exception 'INVALID_ADDRESS_FIELDS' using errcode='22023';end if;
   v_value:=nullif(btrim(p_profile->>v_key),'');
   v_limit:=case when v_key in('address_line1','address_line2') then 160 when v_key in('city','state_region') then 100 else 20 end;
   if char_length(v_value)>v_limit then raise exception 'INVALID_ADDRESS_FIELDS' using errcode='22023';end if;
   v_details:=v_details||jsonb_build_object(v_key,v_value);
  end if;
 end loop;
 if p_profile?'family_members' then
  if jsonb_typeof(p_profile->'family_members')<>'array' then raise exception 'INVALID_FAMILY_FIELDS' using errcode='22023';end if;
  if jsonb_array_length(p_profile->'family_members')>20 then raise exception 'INVALID_FAMILY_FIELDS' using errcode='22023';end if;
  for v_member in select value from jsonb_array_elements(p_profile->'family_members') loop
   if jsonb_typeof(v_member) is distinct from 'object' or not(v_member?&array['first_name','relationship'])
    or (v_member-array['first_name','last_name','relationship','birth_date'])<>'{}'::jsonb
    or jsonb_typeof(v_member->'first_name')<>'string' or jsonb_typeof(v_member->'relationship')<>'string'
    or (v_member?'last_name' and jsonb_typeof(v_member->'last_name') not in('string','null')) then raise exception 'INVALID_FAMILY_FIELDS' using errcode='22023';end if;
   v_first:=btrim(v_member->>'first_name');v_last:=coalesce(btrim(v_member->>'last_name'),'');
   v_birth:=private.app_intake_birth_date(v_member->'birth_date');
   if char_length(v_first) not between 1 and 100 or char_length(v_last)>100 or v_member->>'relationship' not in('spouse','child','parent','guardian','other') then raise exception 'INVALID_FAMILY_FIELDS' using errcode='22023';end if;
   v_family:=v_family||jsonb_build_array(jsonb_build_object('first_name',v_first,'last_name',v_last,'relationship',v_member->>'relationship','birth_date',v_birth));
  end loop;
  v_details:=v_details||jsonb_build_object('family_members',v_family);
 end if;
 return v_details;
end $$;
revoke all on function private.app_intake_birth_date(jsonb),private.app_profile_details(jsonb) from public,anon,authenticated,service_role;

create function private.register_app_guest(p_request_id uuid,p_profile jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_email text; v_payload jsonb; v_details jsonb; v_hash text; v_saved private.app_intake_receipts%rowtype;
  v_row public.app_connections%rowtype; v_job private.app_welcome_outbox%rowtype;
  v_existing boolean; v_receipt jsonb; v_first text; v_last text; v_phone text; v_school text; v_date date;
begin
  v_email := private.lock_app_account();
  if p_request_id is null or jsonb_typeof(p_profile) is distinct from 'object'
    or not (p_profile ?& array['first_name','last_name','phone','preferred_contact','contact_permission','sunday_school','visit_status','first_visit_on'])
    or (p_profile-array['first_name','last_name','phone','preferred_contact','contact_permission','sunday_school','visit_status','first_visit_on','birth_date','membership_status','address_line1','address_line2','city','state_region','postal_code','family_members'])<>'{}'::jsonb
    or jsonb_typeof(p_profile->'first_name')<>'string' or jsonb_typeof(p_profile->'last_name')<>'string'
    or jsonb_typeof(p_profile->'phone') not in ('string','null') or jsonb_typeof(p_profile->'sunday_school') not in ('string','null')
    or jsonb_typeof(p_profile->'preferred_contact')<>'string' or jsonb_typeof(p_profile->'visit_status')<>'string'
    or p_profile->'contact_permission' is distinct from 'true'::jsonb then
    raise exception 'INVALID_GUEST_FIELDS' using errcode='22023';
  end if;
  v_first:=btrim(p_profile->>'first_name'); v_last:=btrim(p_profile->>'last_name');
  v_phone:=nullif(btrim(p_profile->>'phone'),''); v_school:=nullif(btrim(p_profile->>'sunday_school'),'');
  v_date:=private.app_intake_date(p_profile->'first_visit_on');
  if char_length(v_first) not between 1 and 100 or char_length(v_last)>100 or char_length(v_phone)>32 or char_length(v_school)>160
    or p_profile->>'preferred_contact' not in ('email','phone','text') or p_profile->>'visit_status' not in ('not_yet','first_visit','returning')
    or (p_profile->>'preferred_contact'<>'email' and v_phone is null)
    or (p_profile->>'visit_status'='not_yet' and v_date is not null) then
    raise exception 'INVALID_GUEST_FIELDS' using errcode='22023';
  end if;
  v_payload:=jsonb_build_object('first_name',v_first,'last_name',v_last,'phone',v_phone,'preferred_contact',p_profile->>'preferred_contact',
    'contact_permission',true,'sunday_school',v_school,'visit_status',p_profile->>'visit_status','first_visit_on',v_date);
  v_details:=private.app_profile_details(p_profile);
  v_payload:=v_payload||v_details;
  v_hash:=encode(sha256(convert_to(v_payload::text,'UTF8')),'hex');
  select * into v_saved from private.app_intake_receipts where auth_user_id=auth.uid() and kind='guest' and request_id=p_request_id;
  if found then
    if v_saved.payload_hash<>v_hash then raise exception 'REQUEST_ID_CONFLICT' using errcode='40001'; end if;
    return v_saved.receipt;
  end if;
  if (select count(*) from private.app_intake_receipts where auth_user_id=auth.uid() and kind='guest' and created_at>clock_timestamp()-interval '1 hour')>=10 then
    raise exception 'GUEST_RATE_LIMIT' using errcode='P0001';
  end if;
  select * into v_row from public.app_connections where auth_user_id=auth.uid() for update;
  v_existing:=found;
  if v_existing then
    update public.app_connections set first_name=v_first,last_name=v_last,email=v_email,phone=v_phone,
      preferred_contact=p_profile->>'preferred_contact',contact_permission=true,sunday_school=v_school,
      visit_status=p_profile->>'visit_status',first_visit_on=v_date,
      birth_date=case when v_details?'birth_date' then private.app_intake_birth_date(v_details->'birth_date') else birth_date end,
      membership_status=case when v_details?'membership_status' then v_details->>'membership_status' else membership_status end,
      address_line1=case when v_details?'address_line1' then v_details->>'address_line1' else address_line1 end,
      address_line2=case when v_details?'address_line2' then v_details->>'address_line2' else address_line2 end,
      city=case when v_details?'city' then v_details->>'city' else city end,
      state_region=case when v_details?'state_region' then v_details->>'state_region' else state_region end,
      postal_code=case when v_details?'postal_code' then v_details->>'postal_code' else postal_code end,
      family_members=case when v_details?'family_members' then v_details->'family_members' else family_members end,
      version=version+1,status='pending',updated_at=now()
    where id=v_row.id returning * into v_row;
  else
    insert into public.app_connections(auth_user_id,first_name,last_name,email,phone,preferred_contact,contact_permission,sunday_school,visit_status,first_visit_on,follow_up_on,
      birth_date,membership_status,address_line1,address_line2,city,state_region,postal_code,family_members)
    values(auth.uid(),v_first,v_last,v_email,v_phone,p_profile->>'preferred_contact',true,v_school,p_profile->>'visit_status',v_date,(now() at time zone 'America/Chicago')::date+2,
      private.app_intake_birth_date(v_details->'birth_date'),coalesce(v_details->>'membership_status','unsure'),v_details->>'address_line1',v_details->>'address_line2',v_details->>'city',v_details->>'state_region',v_details->>'postal_code',coalesce(v_details->'family_members','[]'::jsonb))
    returning * into v_row;
    insert into private.app_welcome_outbox(registration_id,recipient,recipient_key,first_name)
    values(v_row.id,v_email,lower(v_email),v_first) on conflict(recipient_key) do nothing;
    select * into v_job from private.app_welcome_outbox where recipient_key=lower(v_email) for update;
    insert into private.app_welcome_links(registration_id,outbox_id) values(v_row.id,v_job.id);
    update public.app_connections set welcome_email_status=v_job.status where id=v_row.id and welcome_email_status is distinct from v_job.status returning * into v_row;
    if not found then select * into v_row from public.app_connections where auth_user_id=auth.uid(); end if;
    perform private.create_intake_task('guest_followup',v_row.id,auth.uid());
  end if;
  v_receipt:=jsonb_build_object('id',v_row.id,'version',v_row.version,'submitted_at',v_row.submitted_at,'welcome_email_status',v_row.welcome_email_status);
  insert into private.app_intake_receipts(auth_user_id,kind,request_id,payload_hash,receipt) values(auth.uid(),'guest',p_request_id,v_hash,v_receipt);
  return v_receipt;
end $$;

create or replace function private.get_my_app_connection()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_email text; v_profile jsonb;
begin
  v_email:=private.app_account_email();
  select jsonb_build_object('id',c.id,'first_name',c.first_name,'last_name',c.last_name,'email',v_email,'phone',c.phone,
    'preferred_contact',c.preferred_contact,'contact_permission',c.contact_permission,'sunday_school',c.sunday_school,
    'visit_status',c.visit_status,'first_visit_on',c.first_visit_on,
    'birth_date',c.birth_date,'membership_status',c.membership_status,'address_line1',c.address_line1,'address_line2',c.address_line2,'city',c.city,'state_region',c.state_region,'postal_code',c.postal_code,'family_members',c.family_members,
    'version',c.version,'submitted_at',c.submitted_at,'updated_at',c.updated_at)
  into v_profile from public.app_connections c where c.auth_user_id=auth.uid();
  return v_profile;
end $$;

create function private.submit_app_prayer(p_request_id uuid,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_payload jsonb; v_hash text; v_saved private.app_intake_receipts%rowtype; v_name text; v_text text; v_contact text;
  v_row public.office_prayer_requests%rowtype; v_receipt jsonb;
begin
  perform private.lock_app_account();
  if p_request_id is null or jsonb_typeof(p_request) is distinct from 'object' or not(p_request?'request_text')
    or (p_request-array['display_name','request_text','contact_text'])<>'{}'::jsonb
    or jsonb_typeof(p_request->'request_text')<>'string'
    or (p_request?'display_name' and jsonb_typeof(p_request->'display_name') not in ('string','null'))
    or (p_request?'contact_text' and jsonb_typeof(p_request->'contact_text') not in ('string','null')) then
    raise exception 'INVALID_PRAYER_FIELDS' using errcode='22023';
  end if;
  v_name:=coalesce(nullif(btrim(p_request->>'display_name'),''),'Name not supplied'); v_text:=btrim(p_request->>'request_text'); v_contact:=nullif(btrim(p_request->>'contact_text'),'');
  if char_length(v_name)>160 or char_length(v_text) not between 1 and 10000 or v_text !~ '[^[:space:]]' or char_length(v_contact)>320 then
    raise exception 'INVALID_PRAYER_FIELDS' using errcode='22023';
  end if;
  v_payload:=jsonb_build_object('display_name',v_name,'request_text',v_text,'contact_text',v_contact);
  v_hash:=encode(sha256(convert_to(v_payload::text,'UTF8')),'hex');
  select * into v_saved from private.app_intake_receipts where auth_user_id=auth.uid() and kind='prayer' and request_id=p_request_id;
  if found then
    if v_saved.payload_hash<>v_hash then raise exception 'REQUEST_ID_CONFLICT' using errcode='40001'; end if;
    return v_saved.receipt;
  end if;
  if (select count(*) from private.app_intake_receipts where auth_user_id=auth.uid() and kind='prayer' and created_at>clock_timestamp()-interval '1 hour')>=10
    or (select count(*) from private.app_intake_receipts where auth_user_id=auth.uid() and kind='prayer' and created_at>clock_timestamp()-interval '24 hours')>=50 then
    raise exception 'PRAYER_RATE_LIMIT' using errcode='P0001';
  end if;
  insert into public.office_prayer_requests(display_name,request_text,contact_text,source,submitted_auth_user_id,share_scope,sharing_approved)
  values(v_name,v_text,v_contact,'app',auth.uid(),'staff_only',false) returning * into v_row;
  perform private.create_intake_task('prayer_care',v_row.id,auth.uid());
  v_receipt:=jsonb_build_object('id',v_row.id,'submitted_at',v_row.created_at);
  insert into private.app_intake_receipts(auth_user_id,kind,request_id,payload_hash,receipt) values(auth.uid(),'prayer',p_request_id,v_hash,v_receipt);
  return v_receipt;
end $$;

create function private.preserve_prayer_intake_origin()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.source is distinct from old.source or new.submitted_auth_user_id is distinct from old.submitted_auth_user_id then
    raise exception 'PRAYER_ORIGIN_IMMUTABLE' using errcode='23514';
  end if;
  return new;
end $$;
create trigger office_prayer_intake_origin before update on public.office_prayer_requests
for each row execute function private.preserve_prayer_intake_origin();

create function private.update_guest_followup(p_id uuid,p_staff_version integer,p_changes jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.app_connections%rowtype; v_date date; v_owner text;
begin
  if not coalesce(private.current_staff_role() in ('admin','editor'),false) then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
  if jsonb_typeof(p_changes) is distinct from 'object' or p_changes='{}'::jsonb
    or (p_changes-array['staff_visit_on','follow_up_on','follow_up_status','welcome_owner'])<>'{}'::jsonb
    or (p_changes?'follow_up_status' and (jsonb_typeof(p_changes->'follow_up_status')<>'string' or p_changes->>'follow_up_status' not in ('new','contacted','connected','closed')))
    or (p_changes?'welcome_owner' and jsonb_typeof(p_changes->'welcome_owner') not in ('string','null')) then raise exception 'INVALID_FOLLOWUP_FIELDS' using errcode='22023'; end if;
  if p_changes?'staff_visit_on' then perform private.app_intake_date(p_changes->'staff_visit_on'); end if;
  if p_changes?'follow_up_on' then perform private.app_intake_date(p_changes->'follow_up_on'); end if;
  v_owner:=nullif(btrim(p_changes->>'welcome_owner'),'');
  if char_length(v_owner)>120 then raise exception 'INVALID_FOLLOWUP_FIELDS' using errcode='22023'; end if;
  select * into v_row from public.app_connections where id=p_id for update;
  if not found then raise exception 'GUEST_NOT_FOUND' using errcode='P0002'; end if;
  if p_staff_version is null or p_staff_version<>v_row.staff_version then raise exception 'FOLLOWUP_VERSION_CONFLICT' using errcode='40001'; end if;
  update public.app_connections set
    staff_visit_on=case when p_changes?'staff_visit_on' then private.app_intake_date(p_changes->'staff_visit_on') else staff_visit_on end,
    follow_up_on=case when p_changes?'follow_up_on' then private.app_intake_date(p_changes->'follow_up_on') else follow_up_on end,
    follow_up_status=case when p_changes?'follow_up_status' then p_changes->>'follow_up_status' else follow_up_status end,
    welcome_owner=case when p_changes?'welcome_owner' then v_owner else welcome_owner end,
    staff_version=staff_version+1
  where id=v_row.id returning * into v_row;
  return jsonb_build_object('id',v_row.id,'staff_version',v_row.staff_version);
end $$;

create function private.claim_app_welcome_jobs(p_scope_user_id uuid,p_limit integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_now timestamptz:=clock_timestamp(); v_day date; v_quota integer; v_job private.app_welcome_outbox%rowtype; v_result jsonb:='[]'; v_count integer:=0;
begin
  if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_CLAIM_LIMIT' using errcode='22023'; end if;
  v_day:=(v_now at time zone 'UTC')::date;
  insert into private.app_welcome_daily_quota(utc_day) values(v_day) on conflict do nothing;
  select first_attempts into v_quota from private.app_welcome_daily_quota where utc_day=v_day for update;
  for v_job in select j.* from private.app_welcome_outbox j
    where ((j.status='queued' and j.next_attempt_at<=v_now) or (j.status='sending' and j.lease_until<=v_now))
      and (p_scope_user_id is null or exists(select 1 from private.app_welcome_links l join public.app_connections c on c.id=l.registration_id where l.outbox_id=j.id and c.auth_user_id=p_scope_user_id))
    order by j.first_attempt_at nulls last,j.created_at,j.id limit 100 for update skip locked
  loop
    if not exists(select 1 from private.app_welcome_links l join public.app_connections c on c.id=l.registration_id join auth.users u on u.id=c.auth_user_id
      where l.outbox_id=v_job.id and (p_scope_user_id is null or u.id=p_scope_user_id) and lower(btrim(u.email))=v_job.recipient_key
        and not coalesce(u.is_anonymous,false) and u.deleted_at is null and (u.banned_until is null or u.banned_until<=v_now)
        and char_length(btrim(u.email)) between 3 and 320 and u.email !~ '[[:cntrl:][:space:]]') then
      update private.app_welcome_outbox set status='attention',error_code='invalid_job',lease_token=null,lease_until=null where id=v_job.id;
      update public.app_connections set welcome_email_status='attention' where id in(select registration_id from private.app_welcome_links where outbox_id=v_job.id) and welcome_email_status is distinct from 'attention';
      continue;
    end if;
    if v_job.first_attempt_at is not null and v_job.first_attempt_at+interval '23 hours'<=v_now then
      update private.app_welcome_outbox set status='attention',error_code='retry_window_expired',lease_token=null,lease_until=null where id=v_job.id;
      update public.app_connections set welcome_email_status='attention' where id in(select registration_id from private.app_welcome_links where outbox_id=v_job.id) and welcome_email_status is distinct from 'attention';
      continue;
    end if;
    if v_job.first_attempt_at is null then
      if v_quota>=80 then continue; end if;
      update private.app_welcome_daily_quota set first_attempts=first_attempts+1 where utc_day=v_day returning first_attempts into v_quota;
    end if;
    update private.app_welcome_outbox set status='sending',first_attempt_at=coalesce(first_attempt_at,v_now),attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_until=v_now+interval '120 seconds',error_code=null
    where id=v_job.id returning * into v_job;
    update public.app_connections set welcome_email_status='sending' where id in(select registration_id from private.app_welcome_links where outbox_id=v_job.id) and welcome_email_status is distinct from 'sending';
    v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_job.id,'lease_token',v_job.lease_token,'recipient',v_job.recipient,'first_name',v_job.first_name,'template_version',v_job.template_version,'first_attempt_at',v_job.first_attempt_at,'attempts',v_job.attempts));
    v_count:=v_count+1; if v_count>=p_limit then exit; end if;
  end loop;
  return v_result;
end $$;

create function private.finish_app_welcome_job(p_id uuid,p_lease_token uuid,p_status text,p_provider_id text,p_error_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job private.app_welcome_outbox%rowtype; v_now timestamptz:=clock_timestamp(); v_status text; v_error text;
begin
  if p_status is null or p_status not in ('sent','retry','attention')
    or (p_status='sent' and (p_provider_id is null or p_provider_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or p_error_code is not null))
    or (p_status<>'sent' and (p_provider_id is not null or p_error_code is null or p_error_code not in ('provider_configuration','provider_rejected','provider_rate_limited','provider_unavailable','provider_timeout','provider_invalid_response','idempotency_conflict','delivery_uncertain','retry_window_expired','invalid_job'))) then
    raise exception 'INVALID_FINISH_FIELDS' using errcode='22023';
  end if;
  select * into v_job from private.app_welcome_outbox where id=p_id for update;
  if not found or v_job.status<>'sending' or p_lease_token is null or v_job.lease_token is distinct from p_lease_token or v_job.lease_until<=clock_timestamp() then
    raise exception 'WELCOME_LEASE_CONFLICT' using errcode='40001';
  end if;
  v_status:=case when p_status='retry' then 'queued' else p_status end; v_error:=p_error_code;
  if p_status='retry' and v_job.first_attempt_at+interval '23 hours'<=v_now then v_status:='attention'; v_error:='retry_window_expired'; end if;
  update private.app_welcome_outbox set status=v_status,provider_id=case when p_status='sent' then p_provider_id::uuid else null end,error_code=v_error,
    lease_token=null,lease_until=null,next_attempt_at=case when v_status='queued' then v_now+make_interval(secs=>least(3600,60*power(2,least(attempts-1,6)))::double precision) else next_attempt_at end
  where id=v_job.id;
  update public.app_connections set welcome_email_status=v_status where id in(select registration_id from private.app_welcome_links where outbox_id=v_job.id) and welcome_email_status is distinct from v_status;
  return jsonb_build_object('id',v_job.id,'status',case when v_status='queued' then 'retry' else v_status end);
end $$;

create function public.register_app_guest(p_request_id uuid,p_profile jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.register_app_guest(p_request_id,p_profile) $$;
create function public.submit_app_prayer(p_request_id uuid,p_request jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.submit_app_prayer(p_request_id,p_request) $$;
create function public.update_guest_followup(p_id uuid,p_staff_version integer,p_changes jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.update_guest_followup(p_id,p_staff_version,p_changes) $$;
create function public.claim_app_welcome_jobs(p_scope_user_id uuid,p_limit integer)
returns jsonb language sql security invoker set search_path='' as $$ select private.claim_app_welcome_jobs(p_scope_user_id,p_limit) $$;
create function public.finish_app_welcome_job(p_id uuid,p_lease_token uuid,p_status text,p_provider_id text,p_error_code text)
returns jsonb language sql security invoker set search_path='' as $$ select private.finish_app_welcome_job(p_id,p_lease_token,p_status,p_provider_id,p_error_code) $$;

revoke all on function private.app_account_email(),private.lock_app_account(),private.app_intake_date(jsonb),private.preserve_prayer_intake_origin(),
  private.register_app_guest(uuid,jsonb),public.register_app_guest(uuid,jsonb),private.submit_app_prayer(uuid,jsonb),public.submit_app_prayer(uuid,jsonb),
  private.update_guest_followup(uuid,integer,jsonb),public.update_guest_followup(uuid,integer,jsonb),
  private.claim_app_welcome_jobs(uuid,integer),public.claim_app_welcome_jobs(uuid,integer),
  private.finish_app_welcome_job(uuid,uuid,text,text,text),public.finish_app_welcome_job(uuid,uuid,text,text,text)
from public,anon,authenticated,service_role;
grant execute on function private.register_app_guest(uuid,jsonb),public.register_app_guest(uuid,jsonb),
  private.submit_app_prayer(uuid,jsonb),public.submit_app_prayer(uuid,jsonb),
  private.update_guest_followup(uuid,integer,jsonb),public.update_guest_followup(uuid,integer,jsonb) to authenticated;
grant usage on schema private to service_role;
grant execute on function private.claim_app_welcome_jobs(uuid,integer),public.claim_app_welcome_jobs(uuid,integer),
  private.finish_app_welcome_job(uuid,uuid,text,text,text),public.finish_app_welcome_job(uuid,uuid,text,text,text) to service_role;

create function private.direct_intake_readiness()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not coalesce(private.current_staff_role() in ('admin','editor','viewer'),false) then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
  return jsonb_build_object('available',true,'version',1,'tasks',true,'routes',true);
end $$;
create function public.direct_intake_readiness()
returns jsonb language sql stable security invoker set search_path='' as $$ select private.direct_intake_readiness() $$;
revoke all on function private.direct_intake_readiness(),public.direct_intake_readiness() from public,anon,authenticated,service_role;
grant execute on function private.direct_intake_readiness(),public.direct_intake_readiness() to authenticated;

-- The old non-idempotent submission path stays paused; the old optional reopen is not used.
revoke execute on function public.save_app_connection(text,text,text,text,boolean,text),private.save_app_connection(text,text,text,text,boolean,text) from public,anon,authenticated;
-- Staff tasks and routing are durable parts of submission, not browser callbacks.
create table public.app_submission_tasks (
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in('guest_followup','prayer_care')),
 registration_id uuid unique references public.app_connections(id) on delete restrict,
 prayer_request_id uuid unique references public.office_prayer_requests(id) on delete restrict,
 submitted_auth_user_id uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 due_on date not null,
 status text not null default 'new' check(status in('new','in_progress','completed')),
 assigned_staff_user_id uuid references auth.users(id) on delete restrict,
 routing text not null default 'office' check(routing in('office','staff')),
 version integer not null default 1 check(version>0),
 completed_at timestamptz,
 completed_by uuid references auth.users(id) on delete restrict,
 notification_status text not null default 'queued' check(notification_status in('queued','sending','sent','attention')),
 check((kind='guest_followup' and registration_id is not null and prayer_request_id is null) or (kind='prayer_care' and prayer_request_id is not null and registration_id is null)),
 check((routing='office' and assigned_staff_user_id is null) or (routing='staff' and assigned_staff_user_id is not null)),
 check((status='completed' and completed_at is not null and completed_by is not null) or (status<>'completed' and completed_at is null and completed_by is null))
);
create index app_submission_tasks_due_idx on public.app_submission_tasks(status,due_on);
create index app_submission_tasks_account_idx on public.app_submission_tasks(submitted_auth_user_id);
create index app_submission_tasks_assigned_idx on public.app_submission_tasks(assigned_staff_user_id);
alter table public.app_submission_tasks enable row level security;
revoke all on public.app_submission_tasks from public,anon,authenticated,service_role;
grant select on public.app_submission_tasks to authenticated;
create policy editors_read_app_submission_tasks on public.app_submission_tasks for select to authenticated
using((select private.current_staff_role()) in('admin','editor'));
create trigger app_submission_tasks_audit after insert or update on public.app_submission_tasks for each row execute function private.record_audit();
create policy protect_app_submission_task_audit on public.audit_log as restrictive for select to authenticated
using(entity_type<>'app_submission_tasks' or (select private.current_staff_role()) in('admin','editor'));

create table private.app_intake_routes (
 kind text primary key check(kind in('guest_followup','prayer_care')),
 assigned_staff_user_id uuid references auth.users(id) on delete restrict,
 version integer not null default 1 check(version>0)
);
insert into private.app_intake_routes(kind)values('guest_followup'),('prayer_care');
create table private.app_staff_notice_outbox (
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references public.app_submission_tasks(id) on delete restrict,
 recipient_staff_user_id uuid not null references auth.users(id) on delete restrict,
 recipient text not null check(char_length(recipient) between 3 and 320 and recipient !~ '[[:cntrl:][:space:]]'),
 recipient_key text not null check(recipient_key=lower(btrim(recipient))),
 template_version text not null default 'creek-office-notice-v1' check(template_version='creek-office-notice-v1'),
 status text not null default 'queued' check(status in('queued','sending','sent','attention')),
 created_at timestamptz not null default now(), first_attempt_at timestamptz,
 attempts integer not null default 0 check(attempts>=0), next_attempt_at timestamptz not null default now(),
 lease_token uuid,lease_until timestamptz,provider_id uuid,error_code text,
 unique(task_id,recipient_key),
 check((status='sending' and lease_token is not null and lease_until is not null) or (status<>'sending' and lease_token is null and lease_until is null)),
 check((first_attempt_at is null and attempts=0) or (first_attempt_at is not null and attempts>0)),
 check(status<>'sent' or provider_id is not null)
);
create index app_staff_notice_claim_idx on private.app_staff_notice_outbox(status,next_attempt_at,lease_until);
alter table private.app_intake_routes enable row level security;
alter table private.app_staff_notice_outbox enable row level security;
revoke all on private.app_intake_routes,private.app_staff_notice_outbox from public,anon,authenticated,service_role;

create function private.eligible_intake_staff()
returns table(id uuid,email text,role text) language sql stable security definer set search_path='' as $$
 select u.id,btrim(u.email),r.role from public.staff_roles r join auth.users u on u.id=r.user_id
 where r.role in('admin','editor') and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false)
 and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
 and char_length(btrim(u.email)) between 3 and 320 and u.email !~ '[[:cntrl:][:space:]]'
$$;
create function private.intake_notice_targets(p_task_id uuid)
returns table(id uuid,email text) language sql stable security definer set search_path='' as $$
 select s.id,s.email from public.app_submission_tasks t cross join private.eligible_intake_staff() s
 where t.id=p_task_id and ((t.assigned_staff_user_id is not null and s.id=t.assigned_staff_user_id)
 or (t.assigned_staff_user_id is null and s.role='admin'))
$$;
create function private.refresh_intake_notice_status(p_task_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_status text;
begin
 select case when count(*)=0 or bool_or(j.id is null or j.status='attention') then 'attention'
 when bool_and(j.status='sent') then 'sent' when bool_or(j.status='sending') then 'sending' else 'queued' end
 into v_status from private.intake_notice_targets(p_task_id) s left join private.app_staff_notice_outbox j
 on j.task_id=p_task_id and j.recipient_staff_user_id=s.id and j.recipient_key=lower(s.email);
 update public.app_submission_tasks set notification_status=v_status where id=p_task_id and notification_status is distinct from v_status;
end $$;
create function private.enqueue_intake_notices(p_task_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 -- Existing jobs are immutable. Do not lock them while holding the task row:
 -- claim/finish lock job then task. New recipients alone require an INSERT.
 insert into private.app_staff_notice_outbox(task_id,recipient_staff_user_id,recipient,recipient_key)
 select p_task_id,s.id,s.email,lower(s.email) from private.intake_notice_targets(p_task_id) s
 where not exists(select 1 from private.app_staff_notice_outbox j where j.task_id=p_task_id and j.recipient_key=lower(s.email))
 on conflict(task_id,recipient_key) do nothing;
 perform private.refresh_intake_notice_status(p_task_id);
end $$;
create function private.create_intake_task(p_kind text,p_source_id uuid,p_account_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_assigned uuid;v_task uuid;
begin
 if p_kind='guest_followup' then
  if not exists(select 1 from public.app_connections where id=p_source_id and auth_user_id=p_account_id) then raise exception 'INVALID_TASK_SOURCE' using errcode='22023';end if;
 elsif p_kind='prayer_care' then
  if not exists(select 1 from public.office_prayer_requests where id=p_source_id and submitted_auth_user_id=p_account_id and source='app') then raise exception 'INVALID_TASK_SOURCE' using errcode='22023';end if;
 else raise exception 'INVALID_TASK_KIND' using errcode='22023';end if;
 select r.assigned_staff_user_id into v_assigned from private.app_intake_routes r
 join private.eligible_intake_staff() s on s.id=r.assigned_staff_user_id where r.kind=p_kind;
 insert into public.app_submission_tasks(kind,registration_id,prayer_request_id,submitted_auth_user_id,due_on,assigned_staff_user_id,routing)
 values(p_kind,case when p_kind='guest_followup' then p_source_id end,case when p_kind='prayer_care' then p_source_id end,p_account_id,
 (now() at time zone 'America/Chicago')::date+case when p_kind='guest_followup' then 2 else 0 end,v_assigned,case when v_assigned is null then 'office' else 'staff' end)
 returning id into v_task;
 perform private.enqueue_intake_notices(v_task);
end $$;
create function private.get_intake_settings()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not coalesce(private.current_staff_role() in('admin','editor'),false) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 return jsonb_build_object('version',1,'routes',(select jsonb_agg(to_jsonb(r) order by r.kind) from private.app_intake_routes r),
 'staff',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'label',s.email) order by s.email,s.id),'[]'::jsonb) from private.eligible_intake_staff() s));
end $$;
create function private.set_intake_route(p_kind text,p_version integer,p_assigned_staff_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row private.app_intake_routes%rowtype;
begin
 if private.current_staff_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 if p_kind is null or p_kind not in('guest_followup','prayer_care') or (p_assigned_staff_user_id is not null and not exists(select 1 from private.eligible_intake_staff() where id=p_assigned_staff_user_id)) then raise exception 'INVALID_ROUTE_FIELDS' using errcode='22023';end if;
 select * into v_row from private.app_intake_routes where kind=p_kind for update;
 if p_version is null or p_version<>v_row.version then raise exception 'ROUTE_VERSION_CONFLICT' using errcode='40001';end if;
 update private.app_intake_routes set assigned_staff_user_id=p_assigned_staff_user_id,version=version+1 where kind=p_kind returning * into v_row;
 return jsonb_build_object('kind',v_row.kind,'version',v_row.version);
end $$;
create function private.update_intake_task(p_id uuid,p_version integer,p_changes jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.app_submission_tasks%rowtype;v_due date;v_assigned uuid;v_status text;v_changed boolean;
begin
 if not coalesce(private.current_staff_role() in('admin','editor'),false) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 if jsonb_typeof(p_changes) is distinct from 'object' or p_changes='{}'::jsonb or (p_changes-array['due_on','status','assigned_staff_user_id'])<>'{}'::jsonb
 or (p_changes?'status' and (jsonb_typeof(p_changes->'status')<>'string' or p_changes->>'status' not in('new','in_progress','completed')))
 or (p_changes?'assigned_staff_user_id' and jsonb_typeof(p_changes->'assigned_staff_user_id') not in('string','null')) then raise exception 'INVALID_TASK_FIELDS' using errcode='22023';end if;
 if p_changes?'due_on' then v_due:=private.app_intake_date(p_changes->'due_on');if v_due is null then raise exception 'INVALID_TASK_DATE' using errcode='22023';end if;end if;
 if p_changes?'assigned_staff_user_id' and p_changes->>'assigned_staff_user_id' is not null then
  if p_changes->>'assigned_staff_user_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_TASK_ASSIGNEE' using errcode='22023';end if;
  v_assigned:=(p_changes->>'assigned_staff_user_id')::uuid;
  if not exists(select 1 from private.eligible_intake_staff() where id=v_assigned) then raise exception 'INVALID_TASK_ASSIGNEE' using errcode='22023';end if;
 end if;
 select * into v_row from public.app_submission_tasks where id=p_id for update;
 if not found then raise exception 'TASK_NOT_FOUND' using errcode='P0002';end if;
 if p_version is null or p_version<>v_row.version then raise exception 'TASK_VERSION_CONFLICT' using errcode='40001';end if;
 if not(p_changes?'assigned_staff_user_id') then v_assigned:=v_row.assigned_staff_user_id;end if;
 v_changed:=v_assigned is distinct from v_row.assigned_staff_user_id;
 v_status:=coalesce(p_changes->>'status',v_row.status);
 update public.app_submission_tasks set due_on=coalesce(v_due,due_on),status=v_status,assigned_staff_user_id=v_assigned,
 routing=case when v_assigned is null then 'office' else 'staff' end,version=version+1,
 completed_at=case when v_status='completed' then coalesce(completed_at,clock_timestamp()) end,
 completed_by=case when v_status='completed' then coalesce(completed_by,auth.uid()) end
 where id=p_id returning * into v_row;
 if v_changed then perform private.enqueue_intake_notices(p_id);end if;
 return jsonb_build_object('id',v_row.id,'version',v_row.version);
end $$;

create function private.claim_app_staff_notice_jobs(p_scope_user_id uuid,p_limit integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_now timestamptz:=clock_timestamp();v_day date;v_quota integer;v_job private.app_staff_notice_outbox%rowtype;v_task public.app_submission_tasks%rowtype;v_result jsonb:='[]';v_count integer:=0;v_error text;
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_CLAIM_LIMIT' using errcode='22023';end if;
 v_day:=(v_now at time zone 'UTC')::date;
 insert into private.app_welcome_daily_quota(utc_day)values(v_day)on conflict do nothing;
 select first_attempts into v_quota from private.app_welcome_daily_quota where utc_day=v_day for update;
 for v_job in select j.* from private.app_staff_notice_outbox j join public.app_submission_tasks t on t.id=j.task_id
 where ((j.status='queued' and j.next_attempt_at<=v_now) or (j.status='sending' and j.lease_until<=v_now))
 and (p_scope_user_id is null or t.submitted_auth_user_id=p_scope_user_id)
 order by j.first_attempt_at nulls last,j.created_at,j.id limit 100 for update of j skip locked
 loop
  select * into v_task from public.app_submission_tasks where id=v_job.task_id for update;
  v_error:=null;
  if not exists(select 1 from private.intake_notice_targets(v_job.task_id) s where s.id=v_job.recipient_staff_user_id and lower(s.email)=v_job.recipient_key)
  or not exists(select 1 from auth.users u where u.id=v_task.submitted_auth_user_id and not coalesce(u.is_anonymous,false) and u.deleted_at is null
   and (u.banned_until is null or u.banned_until<=v_now) and char_length(btrim(u.email)) between 3 and 320 and u.email !~ '[[:cntrl:][:space:]]') then v_error:='invalid_job';
  elsif v_job.first_attempt_at is not null and v_job.first_attempt_at+interval '23 hours'<=v_now then v_error:='retry_window_expired';end if;
  if v_error is not null then
   update private.app_staff_notice_outbox set status='attention',error_code=v_error,lease_token=null,lease_until=null where id=v_job.id;
   perform private.refresh_intake_notice_status(v_job.task_id);continue;
  end if;
  if v_job.first_attempt_at is null then
   if v_quota>=80 then continue;end if;
   update private.app_welcome_daily_quota set first_attempts=first_attempts+1 where utc_day=v_day returning first_attempts into v_quota;
  end if;
  update private.app_staff_notice_outbox set status='sending',first_attempt_at=coalesce(first_attempt_at,v_now),attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=v_now+interval '120 seconds',error_code=null
  where id=v_job.id returning * into v_job;
  perform private.refresh_intake_notice_status(v_job.task_id);
  v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_job.id,'lease_token',v_job.lease_token,'recipient',v_job.recipient,'task_id',v_job.task_id,'task_kind',v_task.kind,'template_version',v_job.template_version,'first_attempt_at',v_job.first_attempt_at,'attempts',v_job.attempts));
  v_count:=v_count+1;if v_count>=p_limit then exit;end if;
 end loop;
 return v_result;
end $$;

create function private.finish_app_staff_notice_job(p_id uuid,p_lease_token uuid,p_status text,p_provider_id text,p_error_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job private.app_staff_notice_outbox%rowtype; v_now timestamptz:=clock_timestamp(); v_status text; v_error text;
begin
  if p_status is null or p_status not in ('sent','retry','attention')
    or (p_status='sent' and (p_provider_id is null or p_provider_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or p_error_code is not null))
    or (p_status<>'sent' and (p_provider_id is not null or p_error_code is null or p_error_code not in ('provider_configuration','provider_rejected','provider_rate_limited','provider_unavailable','provider_timeout','provider_invalid_response','idempotency_conflict','delivery_uncertain','retry_window_expired','invalid_job'))) then
    raise exception 'INVALID_FINISH_FIELDS' using errcode='22023';
  end if;
  select * into v_job from private.app_staff_notice_outbox where id=p_id for update;
  if not found or v_job.status<>'sending' or p_lease_token is null or v_job.lease_token is distinct from p_lease_token or v_job.lease_until<=clock_timestamp() then
    raise exception 'NOTICE_LEASE_CONFLICT' using errcode='40001';
  end if;
  v_status:=case when p_status='retry' then 'queued' else p_status end; v_error:=p_error_code;
  if p_status='retry' and v_job.first_attempt_at+interval '23 hours'<=v_now then v_status:='attention'; v_error:='retry_window_expired'; end if;
  update private.app_staff_notice_outbox set status=v_status,provider_id=case when p_status='sent' then p_provider_id::uuid else null end,error_code=v_error,
    lease_token=null,lease_until=null,next_attempt_at=case when v_status='queued' then v_now+make_interval(secs=>least(3600,60*power(2,least(attempts-1,6)))::double precision) else next_attempt_at end
  where id=v_job.id;
  perform private.refresh_intake_notice_status(v_job.task_id);
  return jsonb_build_object('id',v_job.id,'status',case when v_status='queued' then 'retry' else v_status end);
end $$;

create function public.get_intake_settings() returns jsonb language sql security invoker set search_path='' as $$ select private.get_intake_settings() $$;

create function public.set_intake_route(p_kind text,p_version integer,p_assigned_staff_user_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.set_intake_route(p_kind,p_version,p_assigned_staff_user_id) $$;

create function public.update_intake_task(p_id uuid,p_version integer,p_changes jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.update_intake_task(p_id,p_version,p_changes) $$;

create function public.claim_app_staff_notice_jobs(p_scope_user_id uuid,p_limit integer) returns jsonb language sql security invoker set search_path='' as $$ select private.claim_app_staff_notice_jobs(p_scope_user_id,p_limit) $$;

create function public.finish_app_staff_notice_job(p_id uuid,p_lease_token uuid,p_status text,p_provider_id text,p_error_code text) returns jsonb language sql security invoker set search_path='' as $$ select private.finish_app_staff_notice_job(p_id,p_lease_token,p_status,p_provider_id,p_error_code) $$;

revoke all on function private.eligible_intake_staff(),private.intake_notice_targets(uuid),private.refresh_intake_notice_status(uuid),private.enqueue_intake_notices(uuid),private.create_intake_task(text,uuid,uuid),
 private.get_intake_settings(),public.get_intake_settings(),private.set_intake_route(text,integer,uuid),public.set_intake_route(text,integer,uuid),
 private.update_intake_task(uuid,integer,jsonb),public.update_intake_task(uuid,integer,jsonb),
 private.claim_app_staff_notice_jobs(uuid,integer),public.claim_app_staff_notice_jobs(uuid,integer),private.finish_app_staff_notice_job(uuid,uuid,text,text,text),public.finish_app_staff_notice_job(uuid,uuid,text,text,text)
from public,anon,authenticated,service_role;
grant execute on function private.get_intake_settings(),public.get_intake_settings(),private.set_intake_route(text,integer,uuid),public.set_intake_route(text,integer,uuid),private.update_intake_task(uuid,integer,jsonb),public.update_intake_task(uuid,integer,jsonb) to authenticated;
grant execute on function private.claim_app_staff_notice_jobs(uuid,integer),public.claim_app_staff_notice_jobs(uuid,integer),private.finish_app_staff_notice_job(uuid,uuid,text,text,text),public.finish_app_staff_notice_job(uuid,uuid,text,text,text) to service_role;

commit;
