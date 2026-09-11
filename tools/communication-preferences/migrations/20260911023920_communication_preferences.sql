-- Proposed communication preferences after the recorded ten-migration baseline.
-- No recipient seed, staff consent editing, sender, schedule or bulk messages.
begin;

create table private.app_communication_preferences (
 auth_user_id uuid primary key references auth.users(id) on delete restrict,
 email_key text not null check(email_key=lower(btrim(email_key)) and char_length(email_key) between 3 and 320 and email_key !~ '[[:cntrl:][:space:]]'),
 weekly_email boolean not null,
 preference_version integer not null check(preference_version>=1),
 updated_at timestamptz not null default clock_timestamp()
);
create table private.app_communication_receipts (
 auth_user_id uuid not null references auth.users(id) on delete restrict,
 request_id uuid not null,
 mode text not null check(mode in('preference','registration')),
 payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
 email_key text not null check(email_key=lower(btrim(email_key)) and char_length(email_key) between 3 and 320 and email_key !~ '[[:cntrl:][:space:]]'),
 weekly_email boolean not null,
 expected_version integer not null check(expected_version>=0),
 receipt jsonb not null check(jsonb_typeof(receipt)='object'),
 created_at timestamptz not null default clock_timestamp(),
 primary key(auth_user_id,request_id,mode)
);
create index app_communication_receipts_rate_idx on private.app_communication_receipts(auth_user_id,created_at) where weekly_email=true;
alter table private.app_communication_preferences enable row level security;
alter table private.app_communication_receipts enable row level security;
revoke all on private.app_communication_preferences,private.app_communication_receipts from public,anon,authenticated,service_role;

create function private.reject_communication_receipt_change()
returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception 'COMMUNICATION_HISTORY_IMMUTABLE' using errcode='55000';end $$;
create trigger app_communication_receipts_preserve before update or delete on private.app_communication_receipts
for each row execute function private.reject_communication_receipt_change();
create trigger app_communication_receipts_preserve_truncate before truncate on private.app_communication_receipts
for each statement execute function private.reject_communication_receipt_change();

create function private.communication_preference_projection(p_email text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_row private.app_communication_preferences%rowtype;v_matches boolean;
begin
 select * into v_row from private.app_communication_preferences where auth_user_id=auth.uid();
 if not found then return jsonb_build_object('version',1,'preference_version',0,'weekly_email',false,'email_matches',true,'updated_at',null);end if;
 v_matches:=v_row.email_key=lower(btrim(p_email));
 return jsonb_build_object('version',1,'preference_version',v_row.preference_version,'weekly_email',v_row.weekly_email and v_matches,'email_matches',v_matches,'updated_at',v_row.updated_at);
end $$;

create function private.get_my_communication_preferences()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_email text;
begin
 v_email:=private.app_account_email();
 if not exists(select 1 from auth.users where id=auth.uid() and is_anonymous is false) then raise exception 'APP_ACCOUNT_REQUIRED' using errcode='42501';end if;
 return private.communication_preference_projection(v_email);
end $$;

create function private.save_communication_preference(p_request_id uuid,p_expected_version integer,p_weekly_email boolean,p_mode text,p_guest_hash text,p_guest_receipt jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_email text;v_hash text;v_saved private.app_communication_receipts%rowtype;v_row private.app_communication_preferences%rowtype;v_current integer;v_result jsonb;
begin
 v_email:=lower(private.lock_app_account());
 if not exists(select 1 from auth.users where id=auth.uid() and is_anonymous is false) then raise exception 'APP_ACCOUNT_REQUIRED' using errcode='42501';end if;
 if p_request_id is null or p_expected_version is null or p_expected_version<0 or p_weekly_email is null or p_mode is null or p_mode not in('preference','registration')
 or (p_mode='registration' and (p_guest_hash is null or p_guest_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_guest_receipt) is distinct from 'object'))
 or (p_mode='preference' and (p_guest_hash is not null or p_guest_receipt is not null)) then raise exception 'INVALID_COMMUNICATION_FIELDS' using errcode='22023';end if;
 -- Do not hash current email: a historical retry cannot consent for a new address.
 -- Its stored choice remains bound to the email observed on the first commit.
 v_hash:=encode(sha256(convert_to(jsonb_build_object('expected_version',p_expected_version,'weekly_email',p_weekly_email,'guest_hash',p_guest_hash)::text,'UTF8')),'hex');
 select * into v_saved from private.app_communication_receipts where auth_user_id=auth.uid() and request_id=p_request_id and mode=p_mode;
 if found then
  if v_saved.payload_hash<>v_hash then raise exception 'COMMUNICATION_REQUEST_CONFLICT' using errcode='40001';end if;
  return v_saved.receipt;
 end if;
 select * into v_row from private.app_communication_preferences where auth_user_id=auth.uid() for update;
 v_current:=case when found then v_row.preference_version else 0 end;
 if p_expected_version<>v_current then raise exception 'COMMUNICATION_VERSION_CONFLICT' using errcode='40001';end if;
 -- A cap can never block a deliberate opt-out. Existing guest quotas still apply
 -- to the atomic registration RPC. Exact receipt retries were handled above.
 if p_weekly_email and (select count(*) from private.app_communication_receipts where auth_user_id=auth.uid() and weekly_email and created_at>clock_timestamp()-interval '1 hour')>=20 then
  raise exception 'COMMUNICATION_RATE_LIMIT' using errcode='P0001';
 end if;
 insert into private.app_communication_preferences(auth_user_id,email_key,weekly_email,preference_version,updated_at)
 values(auth.uid(),v_email,p_weekly_email,v_current+1,clock_timestamp())
 on conflict(auth_user_id) do update set email_key=excluded.email_key,weekly_email=excluded.weekly_email,preference_version=excluded.preference_version,updated_at=excluded.updated_at;
 v_result:=private.communication_preference_projection(v_email);
 if p_mode='registration' then v_result:=p_guest_receipt||jsonb_build_object('communication_preferences',v_result);end if;
 insert into private.app_communication_receipts(auth_user_id,request_id,mode,payload_hash,email_key,weekly_email,expected_version,receipt)
 values(auth.uid(),p_request_id,p_mode,v_hash,v_email,p_weekly_email,p_expected_version,v_result);
 return v_result;
end $$;

create function private.set_my_communication_preferences(p_request_id uuid,p_expected_version integer,p_weekly_email boolean)
returns jsonb language sql security definer set search_path='' as $$
 select private.save_communication_preference(p_request_id,p_expected_version,p_weekly_email,'preference',null,null)
$$;

create function private.register_app_guest_with_preferences(p_request_id uuid,p_profile jsonb,p_weekly_email boolean,p_preference_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_guest jsonb;v_hash text;
begin
 perform private.lock_app_account();
 if p_request_id is null or p_weekly_email is null or p_preference_version is null or p_preference_version<0 then raise exception 'INVALID_COMMUNICATION_FIELDS' using errcode='22023';end if;
 -- Reuse the existing strict canonical profile validation and exact receipt hash.
 -- Any preference conflict rolls back its profile/task/outbox writes as well.
 v_guest:=private.register_app_guest(p_request_id,p_profile);
 select payload_hash into v_hash from private.app_intake_receipts where auth_user_id=auth.uid() and kind='guest' and request_id=p_request_id;
 return private.save_communication_preference(p_request_id,p_preference_version,p_weekly_email,'registration',v_hash,v_guest);
end $$;

create function private.get_office_communication_audience()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_total integer;v_rows jsonb;
begin
 if not coalesce(private.current_staff_role() in('admin','editor'),false) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 select count(*) into v_total from(select id from public.app_connections limit 5001) c;
 if v_total>5000 then raise exception 'COMMUNICATION_AUDIENCE_LIMIT_EXCEEDED' using errcode='54000';end if;
 with source as (
  select c.id,btrim(c.first_name) first_name,btrim(c.last_name) last_name,btrim(c.email) email,lower(btrim(c.email)) profile_email,
   lower(btrim(u.email)) current_email,
   coalesce(u.id is not null and u.is_anonymous is false and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
    and char_length(btrim(u.email)) between 3 and 320 and u.email !~ '[[:cntrl:][:space:]]'
    and btrim(u.email) ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    and c.email !~ '[[:cntrl:]]' and btrim(c.email) ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$',false) eligible,
   p.email_key preference_email,p.weekly_email,p.preference_version,p.updated_at
  from public.app_connections c left join auth.users u on u.id=c.auth_user_id left join private.app_communication_preferences p on p.auth_user_id=c.auth_user_id
 ), classified as (
  select s.*,count(*) over(partition by profile_email) profile_email_count,count(*) over(partition by current_email) current_email_count from source s
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'first_name',first_name,'last_name',last_name,'email',email,
  'preference_status',case when not eligible then 'account_unavailable'
   when profile_email_count>1 or current_email_count>1 then 'duplicate_email'
   when profile_email is distinct from current_email or (preference_version is not null and preference_email is distinct from current_email) then 'email_changed'
   when preference_version is null then 'not_set' when weekly_email then 'requested' else 'not_requested' end,
  'preference_version',coalesce(preference_version,0),'updated_at',updated_at) order by id),'[]'::jsonb) into v_rows from classified;
 return jsonb_build_object('version',1,'generated_at',clock_timestamp(),'total',v_total,'rows',v_rows);
end $$;

-- The anonymous endpoint is constant-only; anon gains no private-schema access.
create function public.get_app_communication_capabilities()
returns jsonb language sql immutable security invoker set search_path='' as $$ select jsonb_build_object('version',1,'weekly_email',true) $$;
create function public.get_my_communication_preferences()
returns jsonb language sql stable security invoker set search_path='' as $$ select private.get_my_communication_preferences() $$;
create function public.set_my_communication_preferences(p_request_id uuid,p_expected_version integer,p_weekly_email boolean)
returns jsonb language sql security invoker set search_path='' as $$ select private.set_my_communication_preferences(p_request_id,p_expected_version,p_weekly_email) $$;
create function public.register_app_guest_with_preferences(p_request_id uuid,p_profile jsonb,p_weekly_email boolean,p_preference_version integer)
returns jsonb language sql security invoker set search_path='' as $$ select private.register_app_guest_with_preferences(p_request_id,p_profile,p_weekly_email,p_preference_version) $$;
create function public.get_office_communication_audience()
returns jsonb language sql stable security invoker set search_path='' as $$ select private.get_office_communication_audience() $$;
revoke all on function private.reject_communication_receipt_change(),private.communication_preference_projection(text),
 private.save_communication_preference(uuid,integer,boolean,text,text,jsonb),private.get_my_communication_preferences(),private.set_my_communication_preferences(uuid,integer,boolean),private.register_app_guest_with_preferences(uuid,jsonb,boolean,integer),private.get_office_communication_audience(),
 public.get_app_communication_capabilities(),public.get_my_communication_preferences(),public.set_my_communication_preferences(uuid,integer,boolean),public.register_app_guest_with_preferences(uuid,jsonb,boolean,integer),public.get_office_communication_audience()
from public,anon,authenticated,service_role;
grant execute on function public.get_app_communication_capabilities() to anon,authenticated;
grant execute on function private.get_my_communication_preferences(),private.set_my_communication_preferences(uuid,integer,boolean),private.register_app_guest_with_preferences(uuid,jsonb,boolean,integer),private.get_office_communication_audience(),
 public.get_my_communication_preferences(),public.set_my_communication_preferences(uuid,integer,boolean),public.register_app_guest_with_preferences(uuid,jsonb,boolean,integer),public.get_office_communication_audience() to authenticated;
commit;
