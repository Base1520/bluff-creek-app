-- Prepared locally only. No schedule, transport, initial-mail mutation or activation.
-- Apply after the separately reviewed care reminder bindings migration.
begin;

do $$ begin
 if to_regclass('private.care_reminder_settings') is null
 or to_regprocedure('private.care_reminder_source_rows(date)') is null
 or to_regprocedure('private.eligible_intake_staff()') is null then
  raise exception 'CARE_REMINDER_PREREQUISITES_REQUIRED' using errcode='55000';
 end if;
end $$;

create table private.care_reminder_jobs (
 id uuid primary key default gen_random_uuid(),
 destination_key text not null check(destination_key ~ '^[0-9a-f]{64}$'),
 recipient_user_ids uuid[] not null check(cardinality(recipient_user_ids)>0),
 source_refs jsonb not null check(jsonb_typeof(source_refs)='array' and jsonb_array_length(source_refs)>0),
 planned_on date not null,
 template_version text not null default 'creek-care-digest-v1' check(template_version='creek-care-digest-v1'),
 status text not null default 'queued' check(status in('queued','sending','accepted','failed','uncertain','cancelled')),
 version integer not null default 1 check(version>0),
 created_at timestamptz not null,
 next_attempt_at timestamptz not null,
 first_attempt_at timestamptz,
 attempts integer not null default 0 check(attempts between 0 and 8),
 lease_token uuid,
 lease_until timestamptz,
 provider_id text check(provider_id is null or (char_length(provider_id) between 1 and 200 and provider_id !~ '[[:cntrl:]]')),
 error_code text check(error_code is null or error_code in('provider_configuration','provider_rejected','provider_rate_limited','provider_unavailable','provider_timeout','provider_invalid_response','idempotency_conflict','delivery_uncertain','retry_window_expired','invalid_job','source_changed','operator_cancelled','attempt_limit')),
 check((status='sending' and lease_token is not null and lease_until is not null) or (status<>'sending' and lease_token is null and lease_until is null)),
 check((first_attempt_at is null and attempts=0) or (first_attempt_at is not null and attempts>0)),
 check(status<>'accepted' or provider_id is not null)
);
-- Pending or unresolved work blocks all subsequent daily jobs for this address.
create unique index care_reminder_one_pending_destination on private.care_reminder_jobs(destination_key)
 where status in('queued','sending','failed','uncertain');
create index care_reminder_claim on private.care_reminder_jobs(status,next_attempt_at,lease_until);

create table private.care_reminder_occurrences (
 occurrence_key text primary key check(occurrence_key ~ '^[0-9a-f]{64}$'),
 job_id uuid not null references private.care_reminder_jobs(id) on delete restrict,
 kind text not null check(kind in('daily','escalation')),
 created_at timestamptz not null
);
create table private.care_reminder_destination_holds (
 destination_key text primary key check(destination_key ~ '^[0-9a-f]{64}$'),
 job_id uuid not null references private.care_reminder_jobs(id) on delete restrict,
 reason text not null check(reason in('delivery_failed','delivery_uncertain')),
 active boolean not null default true,
 version integer not null default 1 check(version>0),
 created_at timestamptz not null,
 resolved_at timestamptz,
 resolved_by uuid references auth.users(id) on delete restrict,
 check((active and resolved_at is null and resolved_by is null) or (not active and resolved_at is not null and resolved_by is not null))
);
create table private.care_reminder_daily_quota (
 utc_day date primary key,
 first_attempts integer not null default 0 check(first_attempts between 0 and 20)
);
create table private.care_reminder_resolution_receipts (
 request_id uuid primary key,
 actor_id uuid not null references auth.users(id) on delete restrict,
 input_key text not null,
 result jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table private.care_reminder_jobs enable row level security;
alter table private.care_reminder_occurrences enable row level security;
alter table private.care_reminder_destination_holds enable row level security;
alter table private.care_reminder_daily_quota enable row level security;
alter table private.care_reminder_resolution_receipts enable row level security;
revoke all on private.care_reminder_jobs,private.care_reminder_occurrences,private.care_reminder_destination_holds,
 private.care_reminder_daily_quota,private.care_reminder_resolution_receipts from public,anon,authenticated,service_role;

create function private.care_reminder_hash(p_value jsonb)
returns text language sql immutable security invoker set search_path='' as $$
 select encode(sha256(convert_to(p_value::text,'UTF8')),'hex')
$$;
create function private.keep_care_reminder_occurrence()
returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception 'CARE_REMINDER_OCCURRENCE_IMMUTABLE' using errcode='55000'; end $$;
create trigger care_reminder_occurrences_immutable before update or delete on private.care_reminder_occurrences
 for each row execute function private.keep_care_reminder_occurrence();

-- The caller holds the settings singleton lock. Materialize and bound complete
-- sources once; a missing or oversized snapshot raises, never reports all clear.
create function private.care_reminder_targets(p_today date)
returns table(destination_key text,recipient_user_ids uuid[],source_refs jsonb)
language plpgsql stable security definer set search_path='' as $$
declare v_sources jsonb;v_pastors uuid[];v_n integer;
begin
 if p_today is null then raise exception 'CARE_REMINDER_SNAPSHOT_UNAVAILABLE' using errcode='55000';end if;
 select count(*) into v_n from private.care_reminder_settings;
 if v_n<>1 then raise exception 'CARE_REMINDER_SNAPSHOT_UNAVAILABLE' using errcode='55000';end if;
 select s.pastor_user_ids into v_pastors from private.care_reminder_settings s;
 if v_pastors is null or cardinality(v_pastors)>20 then raise exception 'CARE_REMINDER_SNAPSHOT_UNAVAILABLE' using errcode='55000';end if;
 select coalesce(jsonb_agg(to_jsonb(s) order by s.source_type,s.source_id),'[]'::jsonb) into v_sources
 from(select * from private.care_reminder_source_rows(p_today) limit 5001) s;
 if jsonb_array_length(v_sources)>5000 then raise exception 'CARE_REMINDER_SNAPSHOT_LIMIT' using errcode='54000';end if;
 if exists(select 1 from jsonb_to_recordset(v_sources) as s(source_type text,source_id uuid,cycle_id uuid,due_on date,state text,owner_user_id uuid,source_fingerprint text)
  where s.source_type is null or s.source_type not in('care_plan','guest_task') or s.source_id is null or s.cycle_id is null
   or s.state is null or s.state not in('open','completed','paused','removed','inactive')
   or s.source_fingerprint is null or s.source_fingerprint !~ '^[0-9a-f]{64}$')
 or exists(select 1 from jsonb_to_recordset(v_sources) as s(source_type text,source_id uuid) group by s.source_type,s.source_id having count(*)>1) then
  raise exception 'CARE_REMINDER_SNAPSHOT_UNAVAILABLE' using errcode='55000';
 end if;
 select count(*) into v_n from(select id from private.eligible_intake_staff() limit 501) u;
 if v_n>500 then raise exception 'CARE_REMINDER_RECIPIENT_LIMIT' using errcode='54000';end if;
 return query
 with sources as materialized (
  select * from jsonb_to_recordset(v_sources) as s(source_type text,source_id uuid,cycle_id uuid,due_on date,state text,owner_user_id uuid,source_fingerprint text) where s.state='open'
 ), eligible as materialized (
  select e.id,lower(btrim(e.email)) email_key from private.eligible_intake_staff() e
 ), routed as (
  select s.*,e.id recipient_id,e.email_key from sources s join eligible e on e.id=s.owner_user_id where s.due_on<=p_today
  union all
  select s.*,e.id recipient_id,e.email_key from sources s join eligible e on e.id=any(v_pastors)
  where s.due_on<p_today or s.due_on is null or s.owner_user_id is null
   or not exists(select 1 from eligible owner where owner.id=s.owner_user_id)
   or (s.due_on<=p_today and exists(select 1 from eligible owner join private.care_reminder_destination_holds h
     on h.destination_key=private.care_reminder_hash(to_jsonb(owner.email_key)) and h.active where owner.id=s.owner_user_id))
 ), expanded as (
  select private.care_reminder_hash(to_jsonb(r.email_key)) dest,r.recipient_id,
   jsonb_build_object('source_type',r.source_type,'source_id',r.source_id,'cycle_id',r.cycle_id,'due_on',r.due_on,
    'owner_user_id',r.owner_user_id,'source_fingerprint',r.source_fingerprint) ref from routed r
 ), users as (
  select e.dest,array_agg(distinct e.recipient_id order by e.recipient_id) ids from expanded e group by e.dest
 ), refs as (
  select distinct e.dest,e.ref from expanded e
 )
 select u.dest,u.ids,jsonb_agg(r.ref order by r.ref->>'source_type',r.ref->>'source_id')
 from users u join refs r on r.dest=u.dest group by u.dest,u.ids order by u.dest;
end $$;

create function private.enqueue_care_reminders_at(p_now timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_settings private.care_reminder_settings%rowtype;v_today date;v_hour integer;
 v_target record;v_ref jsonb;v_keys jsonb;v_key text;v_job uuid;v_count integer:=0;v_pending integer:=0;
begin
 if p_now is null or not isfinite(p_now) then raise exception 'INVALID_REMINDER_CLOCK' using errcode='22023';end if;
 select * into v_settings from private.care_reminder_settings where id=true for update;
 if not found then raise exception 'CARE_REMINDER_SNAPSHOT_UNAVAILABLE' using errcode='55000';end if;
 if not v_settings.enabled then return jsonb_build_object('status','paused','enqueued',0);end if;
 v_today:=(p_now at time zone 'America/Chicago')::date;v_hour:=extract(hour from p_now at time zone 'America/Chicago');
 if v_hour<9 or v_hour>=17 then return jsonb_build_object('status','waiting','enqueued',0);end if;
 for v_target in select * from private.care_reminder_targets(v_today) loop
  if exists(select 1 from private.care_reminder_destination_holds h where h.destination_key=v_target.destination_key and h.active)
  or exists(select 1 from private.care_reminder_jobs j where j.destination_key=v_target.destination_key and j.status in('queued','sending','failed','uncertain')) then
   v_pending:=v_pending+1;continue;
  end if;
  v_keys:='[]';v_key:=private.care_reminder_hash(jsonb_build_array('creek-care-v1','daily',v_today,v_target.destination_key));
  if not exists(select 1 from private.care_reminder_occurrences o where o.occurrence_key=v_key) then
   v_keys:=v_keys||jsonb_build_array(jsonb_build_object('key',v_key,'kind','daily'));
  end if;
  for v_ref in select value from jsonb_array_elements(v_target.source_refs) loop
   if (v_ref->>'due_on')::date<=v_today-3 then
    v_key:=private.care_reminder_hash(jsonb_build_array('creek-care-v1','escalation',v_ref->>'source_type',v_ref->>'source_id',v_ref->>'cycle_id',v_ref->>'due_on',v_target.destination_key));
    if not exists(select 1 from private.care_reminder_occurrences o where o.occurrence_key=v_key) then
     v_keys:=v_keys||jsonb_build_array(jsonb_build_object('key',v_key,'kind','escalation'));
    end if;
   end if;
  end loop;
  if jsonb_array_length(v_keys)=0 then continue;end if;
  insert into private.care_reminder_jobs(destination_key,recipient_user_ids,source_refs,planned_on,created_at,next_attempt_at)
   values(v_target.destination_key,v_target.recipient_user_ids,v_target.source_refs,v_today,p_now,p_now) returning id into v_job;
  insert into private.care_reminder_occurrences(occurrence_key,job_id,kind,created_at)
   select k->>'key',v_job,k->>'kind',p_now from jsonb_array_elements(v_keys) k;
  v_count:=v_count+1;
 end loop;
 return jsonb_build_object('status','enqueued','enqueued',v_count,'pending_destinations',v_pending);
end $$;

create function private.hold_care_reminder_job(p_id uuid,p_status text,p_error text,p_now timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare v_job private.care_reminder_jobs%rowtype;
begin
 update private.care_reminder_jobs set status=p_status,error_code=p_error,lease_token=null,lease_until=null,version=version+1
 where id=p_id returning * into v_job;
 if not found then raise exception 'CARE_REMINDER_JOB_NOT_FOUND' using errcode='P0002';end if;
 insert into private.care_reminder_destination_holds(destination_key,job_id,reason,created_at)
 values(v_job.destination_key,v_job.id,case when p_status='uncertain' then 'delivery_uncertain' else 'delivery_failed' end,p_now)
 on conflict(destination_key) do update set job_id=excluded.job_id,reason=excluded.reason,active=true,
  version=private.care_reminder_destination_holds.version+1,created_at=p_now,resolved_at=null,resolved_by=null;
end $$;

create function private.claim_care_reminder_jobs_at(p_limit integer,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_settings private.care_reminder_settings%rowtype;v_today date;v_day date;v_hour integer;
 v_job private.care_reminder_jobs%rowtype;v_target jsonb;v_targets jsonb;v_recipient text;v_count integer:=0;v_quota integer;v_result jsonb:='[]';
begin
 if p_limit is null or p_limit not between 1 and 10 or p_now is null or not isfinite(p_now) then raise exception 'INVALID_REMINDER_CLAIM' using errcode='22023';end if;
 select * into v_settings from private.care_reminder_settings where id=true for update;
 if not found then raise exception 'CARE_REMINDER_SNAPSHOT_UNAVAILABLE' using errcode='55000';end if;
 if not v_settings.enabled then return '[]';end if;
 v_today:=(p_now at time zone 'America/Chicago')::date;v_day:=(p_now at time zone 'UTC')::date;
 v_hour:=extract(hour from p_now at time zone 'America/Chicago');
 if v_hour<9 or v_hour>=17 then return '[]';end if;
 select coalesce(jsonb_agg(to_jsonb(t)),'[]') into v_targets from private.care_reminder_targets(v_today) t;
 insert into private.care_reminder_daily_quota(utc_day) values(v_day) on conflict do nothing;
 select first_attempts into v_quota from private.care_reminder_daily_quota where utc_day=v_day for update;
 for v_job in select j.* from private.care_reminder_jobs j
  where (j.status='queued' and j.next_attempt_at<=p_now) or (j.status='sending' and j.lease_until<=p_now)
  order by j.created_at,j.id limit 100 for update skip locked
 loop
  if v_job.status='sending' then
   -- A vanished worker may already have reached the provider. Never reclaim its
   -- expired lease as a new send; require explicit operator resolution instead.
   perform private.hold_care_reminder_job(v_job.id,'uncertain','delivery_uncertain',p_now);continue;
  end if;
  if exists(select 1 from private.care_reminder_destination_holds h where h.destination_key=v_job.destination_key and h.active) then continue;end if;
  select t into v_target from jsonb_array_elements(v_targets) t where t->>'destination_key'=v_job.destination_key;
  if v_target is null or v_target->'source_refs' is distinct from v_job.source_refs
   or v_target->'recipient_user_ids' is distinct from to_jsonb(v_job.recipient_user_ids) then
   update private.care_reminder_jobs set status='cancelled',error_code='source_changed',version=version+1 where id=v_job.id;continue;
  end if;
  select lower(btrim(e.email)) into v_recipient from private.eligible_intake_staff() e where e.id=any(v_job.recipient_user_ids)
   and private.care_reminder_hash(to_jsonb(lower(btrim(e.email))))=v_job.destination_key order by e.id limit 1;
  if v_recipient is null then
   update private.care_reminder_jobs set status='cancelled',error_code='source_changed',version=version+1 where id=v_job.id;continue;
  end if;
  if v_job.first_attempt_at is not null and v_job.first_attempt_at+interval '23 hours'<=p_now then
   perform private.hold_care_reminder_job(v_job.id,'failed','retry_window_expired',p_now);continue;
  end if;
  if v_job.attempts>=8 then perform private.hold_care_reminder_job(v_job.id,'failed','attempt_limit',p_now);continue;end if;
  if v_job.first_attempt_at is null then
   if v_quota>=20 then continue;end if;
   update private.care_reminder_daily_quota set first_attempts=first_attempts+1 where utc_day=v_day returning first_attempts into v_quota;
  end if;
  update private.care_reminder_jobs set status='sending',first_attempt_at=coalesce(first_attempt_at,p_now),attempts=attempts+1,
   lease_token=gen_random_uuid(),lease_until=p_now+interval '120 seconds',error_code=null,version=version+1
   where id=v_job.id returning * into v_job;
  v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_job.id,'lease_token',v_job.lease_token,
   'recipient',v_recipient,'template_version',v_job.template_version,'attempts',v_job.attempts,
   'first_attempt_at',v_job.first_attempt_at,'provider_key','care-'||v_job.id::text));
  v_count:=v_count+1;if v_count>=p_limit then exit;end if;
 end loop;
 return v_result;
end $$;

create function private.finish_care_reminder_job_at(p_id uuid,p_lease_token uuid,p_status text,p_provider_id text,p_error_code text,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job private.care_reminder_jobs%rowtype;v_status text;v_error text;
begin
 if p_now is null or not isfinite(p_now) or p_status is null or p_status not in('accepted','retry','failed','uncertain')
 or (p_status='accepted' and (p_provider_id is null or char_length(btrim(p_provider_id)) not between 1 and 200 or p_provider_id ~ '[[:cntrl:]]' or p_error_code is not null))
 or (p_status<>'accepted' and (p_provider_id is not null or p_error_code is null or p_error_code not in('provider_configuration','provider_rejected','provider_rate_limited','provider_unavailable','provider_timeout','provider_invalid_response','idempotency_conflict','delivery_uncertain','retry_window_expired','invalid_job')))
 or (p_status='retry' and p_error_code not in('provider_rate_limited','provider_unavailable')) then
  raise exception 'INVALID_REMINDER_FINISH' using errcode='22023';
 end if;
 -- Recording a provider result remains possible while settings are paused.
 perform id from private.care_reminder_settings where id=true for update;
 if not found then raise exception 'CARE_REMINDER_SNAPSHOT_UNAVAILABLE' using errcode='55000';end if;
 select * into v_job from private.care_reminder_jobs where id=p_id for update;
 if not found or v_job.status<>'sending' or p_lease_token is null or v_job.lease_token is distinct from p_lease_token or v_job.lease_until<=p_now then
  raise exception 'CARE_REMINDER_LEASE_CONFLICT' using errcode='40001';
 end if;
 v_status:=p_status;v_error:=p_error_code;
 if p_status='retry' and (v_job.first_attempt_at+interval '23 hours'<=p_now or v_job.attempts>=8) then
  v_status:='failed';v_error:=case when v_job.attempts>=8 then 'attempt_limit' else 'retry_window_expired' end;
 end if;
 if v_status in('failed','uncertain') then
  perform private.hold_care_reminder_job(v_job.id,v_status,v_error,p_now);
 else
  update private.care_reminder_jobs set status=case when v_status='retry' then 'queued' else 'accepted' end,
   provider_id=p_provider_id,error_code=v_error,lease_token=null,lease_until=null,version=version+1,
   next_attempt_at=case when v_status='retry' then p_now+make_interval(secs=>least(3600,60*power(2,least(attempts-1,6)))::double precision) else next_attempt_at end
   where id=v_job.id;
 end if;
 select * into v_job from private.care_reminder_jobs where id=p_id;
 return jsonb_build_object('id',v_job.id,'status',v_status,'version',v_job.version);
end $$;

create function private.resolve_care_reminder_job(p_request_id uuid,p_id uuid,p_version integer,p_resolution text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job private.care_reminder_jobs%rowtype;v_saved private.care_reminder_resolution_receipts%rowtype;v_key text;v_result jsonb;
begin
 if private.current_staff_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 if p_request_id is null or p_id is null or p_version is null or p_version<1 or p_resolution is distinct from 'cancel_no_resend' then
  raise exception 'INVALID_REMINDER_RESOLUTION' using errcode='22023';end if;
 perform id from private.care_reminder_settings where id=true for update;
 if not found then raise exception 'CARE_REMINDER_SNAPSHOT_UNAVAILABLE' using errcode='55000';end if;
 v_key:=private.care_reminder_hash(jsonb_build_array(p_id,p_version,p_resolution));
 select * into v_saved from private.care_reminder_resolution_receipts where request_id=p_request_id;
 if found then
  if v_saved.actor_id<>auth.uid() or v_saved.input_key<>v_key then raise exception 'CARE_REMINDER_RESOLUTION_CONFLICT' using errcode='40001';end if;
  return v_saved.result;
 end if;
 select * into v_job from private.care_reminder_jobs where id=p_id for update;
 if not found then raise exception 'CARE_REMINDER_JOB_NOT_FOUND' using errcode='P0002';end if;
 if v_job.version<>p_version then raise exception 'CARE_REMINDER_VERSION_CONFLICT' using errcode='40001';end if;
 if v_job.status not in('queued','failed','uncertain') then raise exception 'CARE_REMINDER_RESOLUTION_STATE' using errcode='55000';end if;
 update private.care_reminder_jobs set status='cancelled',error_code='operator_cancelled',version=version+1 where id=p_id returning * into v_job;
 update private.care_reminder_destination_holds set active=false,resolved_at=clock_timestamp(),resolved_by=auth.uid(),version=version+1
  where destination_key=v_job.destination_key and active;
 v_result:=jsonb_build_object('id',v_job.id,'version',v_job.version,'status','cancelled','resolution','cancel_no_resend');
 insert into private.care_reminder_resolution_receipts(request_id,actor_id,input_key,result) values(p_request_id,auth.uid(),v_key,v_result);
 insert into public.audit_log(actor_id,action,entity_type,entity_id) values(auth.uid(),'update','care_reminder_jobs',v_job.id::text||'/v'||v_job.version::text);
 return v_result;
end $$;

create function public.enqueue_care_reminders()
returns jsonb language sql security definer set search_path='' as $$select private.enqueue_care_reminders_at(clock_timestamp())$$;
create function public.claim_care_reminder_jobs(p_limit integer)
returns jsonb language sql security definer set search_path='' as $$select private.claim_care_reminder_jobs_at(p_limit,clock_timestamp())$$;
create function public.finish_care_reminder_job(p_id uuid,p_lease_token uuid,p_status text,p_provider_id text,p_error_code text)
returns jsonb language sql security definer set search_path='' as $$select private.finish_care_reminder_job_at(p_id,p_lease_token,p_status,p_provider_id,p_error_code,clock_timestamp())$$;
create function public.resolve_care_reminder_job(p_request_id uuid,p_id uuid,p_version integer,p_resolution text)
returns jsonb language sql security invoker set search_path='' as $$select private.resolve_care_reminder_job(p_request_id,p_id,p_version,p_resolution)$$;

revoke all on function private.care_reminder_hash(jsonb),private.keep_care_reminder_occurrence(),private.care_reminder_targets(date),
 private.enqueue_care_reminders_at(timestamptz),private.hold_care_reminder_job(uuid,text,text,timestamptz),
 private.claim_care_reminder_jobs_at(integer,timestamptz),private.finish_care_reminder_job_at(uuid,uuid,text,text,text,timestamptz),
 private.resolve_care_reminder_job(uuid,uuid,integer,text),public.enqueue_care_reminders(),public.claim_care_reminder_jobs(integer),
 public.finish_care_reminder_job(uuid,uuid,text,text,text),public.resolve_care_reminder_job(uuid,uuid,integer,text)
 from public,anon,authenticated,service_role;
grant execute on function public.enqueue_care_reminders(),public.claim_care_reminder_jobs(integer),public.finish_care_reminder_job(uuid,uuid,text,text,text) to service_role;
grant execute on function private.resolve_care_reminder_job(uuid,uuid,integer,text),public.resolve_care_reminder_job(uuid,uuid,integer,text) to authenticated;

-- A claim rechecks a complete current projection and recipient permissions before
-- returning the minimal private worker envelope. No source lock spans HTTP. Care
-- edits after this transaction may still race with provider acceptance; the fixed
-- generic payload contains no names/notes and the Office link rechecks access.
-- Provider idempotency plus receipts limits duplicates; it is not exactly-once
-- delivery. A lease expiry is uncertainty, never permission to blindly resend.
commit;
