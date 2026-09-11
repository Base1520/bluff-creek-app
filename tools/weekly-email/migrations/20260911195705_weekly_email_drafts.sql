-- Proposed private weekly-email wording drafts. No sender, recipient snapshot,
-- public announcement publication, provider, worker or schedule changes.
begin;

create table private.app_weekly_email_write_guard (
 id boolean primary key default true check(id)
);
insert into private.app_weekly_email_write_guard(id) values(true);
create table private.app_weekly_email_drafts (
 id uuid primary key,
 version integer not null check(version>0),
 week_start date not null,
 subject text not null,
 intro text not null,
 closing text not null,
 sources jsonb not null check(jsonb_typeof(sources)='array'),
 status text not null check(status in('draft','reviewed')),
 content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),
 reviewed_at timestamptz,
 reviewed_by uuid references auth.users(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),
 created_by uuid not null references auth.users(id) on delete restrict,
 updated_at timestamptz not null,
 updated_by uuid not null references auth.users(id) on delete restrict,
 check((status='draft' and reviewed_at is null and reviewed_by is null)
    or (status='reviewed' and reviewed_at is not null and reviewed_by is not null))
);
create index app_weekly_email_drafts_week_idx on private.app_weekly_email_drafts(week_start,id);
create table private.app_weekly_email_revisions (
 draft_id uuid not null references private.app_weekly_email_drafts(id) on delete restrict,
 version integer not null check(version>0),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 actor_id uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),
 primary key(draft_id,version)
);
create table private.app_weekly_email_receipts (
 actor_id uuid not null references auth.users(id) on delete restrict,
 request_id uuid not null,
 operation text not null check(operation in('save','review')),
 payload_hash text not null check(payload_hash ~ '^[a-f0-9]{64}$'),
 receipt jsonb not null check(jsonb_typeof(receipt)='object'),
 created_at timestamptz not null default clock_timestamp(),
 primary key(actor_id,request_id)
);
alter table private.app_weekly_email_write_guard enable row level security;
alter table private.app_weekly_email_drafts enable row level security;
alter table private.app_weekly_email_revisions enable row level security;
alter table private.app_weekly_email_receipts enable row level security;
revoke all on private.app_weekly_email_write_guard,private.app_weekly_email_drafts,
 private.app_weekly_email_revisions,private.app_weekly_email_receipts from public,anon,authenticated,service_role;

create function private.reject_weekly_email_history_change()
returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception 'WEEKLY_EMAIL_HISTORY_IMMUTABLE' using errcode='55000';end $$;
create trigger app_weekly_email_revisions_immutable before update or delete on private.app_weekly_email_revisions
for each row execute function private.reject_weekly_email_history_change();
create trigger app_weekly_email_revisions_no_truncate before truncate on private.app_weekly_email_revisions
for each statement execute function private.reject_weekly_email_history_change();
create trigger app_weekly_email_receipts_immutable before update or delete on private.app_weekly_email_receipts
for each row execute function private.reject_weekly_email_history_change();
create trigger app_weekly_email_receipts_no_truncate before truncate on private.app_weekly_email_receipts
for each statement execute function private.reject_weekly_email_history_change();

create function private.weekly_email_week(p_week date)
returns date language plpgsql immutable security invoker set search_path='' as $$
begin
 if p_week is null or not isfinite(p_week) or p_week<date '2000-01-01' or p_week>date '2100-12-31'
 or extract(isodow from p_week)<>1 then raise exception 'INVALID_WEEKLY_EMAIL_WEEK' using errcode='22023';end if;
 return p_week;
end $$;

create function private.lock_weekly_email_actor(p_review boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_review then
  if private.current_staff_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 elsif not coalesce(private.current_staff_role() in('admin','editor'),false) then
  raise exception 'STAFF_REQUIRED' using errcode='42501';
 end if;
 -- Every weekly write takes this private singleton first. It serializes low-
 -- traffic draft writes, prevents same-UUID create races, and makes the per-week
 -- twenty-draft limit atomic, including moves between weeks.
 perform id from private.app_weekly_email_write_guard where id=true for update;
 if not found then raise exception 'INVALID_WEEKLY_EMAIL_FIELDS' using errcode='22023';end if;
 -- Auth eligibility changes still serialize, but ordinary source/audit foreign
 -- keys may take KEY SHARE while an announcement editor holds a source row.
 -- FOR UPDATE here would invert actor/source locks for the same staff member.
 perform id from auth.users where id=auth.uid() for no key update;
 if p_review then
  if private.current_staff_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 elsif not coalesce(private.current_staff_role() in('admin','editor'),false) then
  raise exception 'STAFF_REQUIRED' using errcode='42501';
 end if;
end $$;

create function private.weekly_email_source_snapshot(p_refs jsonb,p_week date)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_ref jsonb;v_source public.office_announcements%rowtype;v_sources jsonb:='[]'::jsonb;v_chars integer:=0;
begin
 if jsonb_typeof(p_refs) is distinct from 'array' then
  raise exception 'INVALID_WEEKLY_EMAIL_FIELDS' using errcode='22023';end if;
 if jsonb_array_length(p_refs)>12 then
  raise exception 'INVALID_WEEKLY_EMAIL_FIELDS' using errcode='22023';end if;
 for v_ref in select value from jsonb_array_elements(p_refs) loop
  if jsonb_typeof(v_ref) is distinct from 'object' or not(v_ref?&array['id','version'])
   or (v_ref-array['id','version'])<>'{}'::jsonb or jsonb_typeof(v_ref->'id') is distinct from 'string'
   or v_ref->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or jsonb_typeof(v_ref->'version') is distinct from 'number' or v_ref->>'version' !~ '^[1-9][0-9]{0,9}$'
   or (v_ref->>'version')::numeric>2147483647 then raise exception 'INVALID_WEEKLY_EMAIL_FIELDS' using errcode='22023';end if;
 end loop;
 if (select count(distinct (value->>'id')::uuid) from jsonb_array_elements(p_refs))<>jsonb_array_length(p_refs) then
  raise exception 'INVALID_WEEKLY_EMAIL_FIELDS' using errcode='22023';end if;
 -- Lock in UUID order, but preserve the explicitly selected presentation order.
 perform a.id from public.office_announcements a join jsonb_array_elements(p_refs) r on a.id=(r->>'id')::uuid order by a.id for update of a;
 for v_ref in select value from jsonb_array_elements(p_refs) loop
  select * into v_source from public.office_announcements where id=(v_ref->>'id')::uuid;
  if not found or v_source.version<>(v_ref->>'version')::integer or v_source.status<>'ready'
   or (v_source.starts_on is not null and v_source.starts_on>p_week+6)
   or (v_source.ends_on is not null and v_source.ends_on<p_week) then
   raise exception 'WEEKLY_EMAIL_SOURCE_CHANGED' using errcode='40001';end if;
  v_chars:=v_chars+char_length(v_source.title)+char_length(v_source.body);
  if v_chars>30000 then raise exception 'WEEKLY_EMAIL_LIMIT_EXCEEDED' using errcode='54000';end if;
  v_sources:=v_sources||jsonb_build_array(jsonb_build_object('id',v_source.id,'version',v_source.version,
    'title',v_source.title,'body',v_source.body,'starts_on',v_source.starts_on,'ends_on',v_source.ends_on));
 end loop;
 return v_sources;
end $$;

create function private.weekly_email_sources_current(p_sources jsonb,p_week date)
returns boolean language sql stable security invoker set search_path='' as $$
 select not exists(select 1 from jsonb_array_elements(p_sources) s
 left join public.office_announcements a on a.id=(s->>'id')::uuid
 where a.id is null or a.status<>'ready' or (a.starts_on is not null and a.starts_on>p_week+6)
 or (a.ends_on is not null and a.ends_on<p_week)
 or s<>jsonb_build_object('id',a.id,'version',a.version,'title',a.title,'body',a.body,'starts_on',a.starts_on,'ends_on',a.ends_on))
$$;

create function private.get_weekly_email_workspace(p_week_start date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_week date;v_drafts jsonb;v_sources jsonb;v_audience jsonb;v_counts jsonb;
begin
 if not coalesce(private.current_staff_role() in('admin','editor'),false) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 v_week:=private.weekly_email_week(p_week_start);
 select coalesce(jsonb_agg(row order by id),'[]'::jsonb) into v_drafts from
  (select id,version,subject,status,updated_at from private.app_weekly_email_drafts where week_start=v_week order by id limit 21) row;
 if jsonb_array_length(v_drafts)>20 then raise exception 'WEEKLY_EMAIL_LIMIT_EXCEEDED' using errcode='54000';end if;
 select coalesce(jsonb_agg(row order by id),'[]'::jsonb) into v_sources from
  (select id,version,title,body,starts_on,ends_on from public.office_announcements
   where status='ready' and (starts_on is null or starts_on<=v_week+6) and (ends_on is null or ends_on>=v_week)
   order by id limit 201) row;
 if jsonb_array_length(v_sources)>200 then raise exception 'WEEKLY_EMAIL_LIMIT_EXCEEDED' using errcode='54000';end if;
 begin v_audience:=private.get_office_communication_audience();
 exception when sqlstate '54000' then raise exception 'WEEKLY_EMAIL_LIMIT_EXCEEDED' using errcode='54000';end;
 select jsonb_build_object('total',count(*),'requested',count(*) filter(where value->>'preference_status'='requested'),
  'held',count(*) filter(where value->>'preference_status' in('email_changed','duplicate_email','account_unavailable')),
  'not_requested',count(*) filter(where value->>'preference_status' in('not_requested','not_set'))) into v_counts
 from jsonb_array_elements(v_audience->'rows');
 return jsonb_build_object('version',1,'week_start',v_week,'generated_at',statement_timestamp(),
  'drafts',v_drafts,'announcements',v_sources,'audience',v_counts);
end $$;

create function private.get_weekly_email_draft(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_row private.app_weekly_email_drafts%rowtype;v_current boolean;
begin
 if not coalesce(private.current_staff_role() in('admin','editor'),false) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 select * into v_row from private.app_weekly_email_drafts where id=p_id;
 if not found then raise exception 'WEEKLY_EMAIL_NOT_FOUND' using errcode='P0002';end if;
 v_current:=private.weekly_email_sources_current(v_row.sources,v_row.week_start);
 return jsonb_build_object('version',1,'draft',to_jsonb(v_row)-array['created_at','created_by','updated_by','reviewed_by'],
  'sources_current',v_current,'review_current',v_row.status='reviewed' and v_current,'sending_enabled',false);
end $$;

create function private.save_weekly_email_draft(p_request_id uuid,p_id uuid,p_expected_version integer,p_draft jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row private.app_weekly_email_drafts%rowtype;v_saved private.app_weekly_email_receipts%rowtype;
 v_exists boolean;v_week date;v_subject text;v_sources jsonb;v_payload_hash text;v_content_hash text;v_receipt jsonb;
begin
 perform private.lock_weekly_email_actor(false);
 if p_request_id is null or p_id is null or p_expected_version is null or p_expected_version<0
 or jsonb_typeof(p_draft) is distinct from 'object'
 or not(p_draft?&array['week_start','subject','intro','closing','announcement_refs'])
 or (p_draft-array['week_start','subject','intro','closing','announcement_refs'])<>'{}'::jsonb
 or jsonb_typeof(p_draft->'week_start') is distinct from 'string' or p_draft->>'week_start' !~ '^\d{4}-\d{2}-\d{2}$'
 or jsonb_typeof(p_draft->'subject') is distinct from 'string' or jsonb_typeof(p_draft->'intro') is distinct from 'string'
 or jsonb_typeof(p_draft->'closing') is distinct from 'string' then raise exception 'INVALID_WEEKLY_EMAIL_FIELDS' using errcode='22023';end if;
 begin v_week:=(p_draft->>'week_start')::date;
 exception when datetime_field_overflow or invalid_datetime_format then raise exception 'INVALID_WEEKLY_EMAIL_WEEK' using errcode='22023';end;
 v_week:=private.weekly_email_week(v_week);
 v_subject:=btrim(p_draft->>'subject');
 if char_length(v_subject) not between 1 and 160 or v_subject !~ '[^[:space:]]' or v_subject ~ '[[:cntrl:]]'
 or char_length(p_draft->>'intro')>4000 or char_length(p_draft->>'closing')>2000
 or regexp_replace(p_draft->>'intro',E'[\n\r\t]','','g') ~ '[[:cntrl:]]'
 or regexp_replace(p_draft->>'closing',E'[\n\r\t]','','g') ~ '[[:cntrl:]]' then raise exception 'INVALID_WEEKLY_EMAIL_FIELDS' using errcode='22023';end if;
 v_payload_hash:=encode(sha256(convert_to(jsonb_build_object('operation','save','id',p_id,'expected_version',p_expected_version,'draft',p_draft)::text,'UTF8')),'hex');
 select * into v_saved from private.app_weekly_email_receipts where actor_id=auth.uid() and request_id=p_request_id;
 if found then
  if v_saved.operation<>'save' or v_saved.payload_hash<>v_payload_hash then raise exception 'WEEKLY_EMAIL_REQUEST_CONFLICT' using errcode='40001';end if;
  return v_saved.receipt;
 end if;
 select * into v_row from private.app_weekly_email_drafts where id=p_id for update;v_exists:=found;
 if not v_exists and p_expected_version<>0 then raise exception 'WEEKLY_EMAIL_NOT_FOUND' using errcode='P0002';end if;
 if v_exists and v_row.version<>p_expected_version then
  raise exception 'WEEKLY_EMAIL_VERSION_CONFLICT' using errcode='40001';end if;
 if (not v_exists or v_row.week_start<>v_week)
  and (select count(*) from private.app_weekly_email_drafts where week_start=v_week)>=20 then
  raise exception 'WEEKLY_EMAIL_LIMIT_EXCEEDED' using errcode='54000';end if;
 v_sources:=private.weekly_email_source_snapshot(p_draft->'announcement_refs',v_week);
 v_content_hash:=encode(sha256(convert_to(jsonb_build_object('week_start',v_week,'subject',v_subject,
  'intro',p_draft->>'intro','closing',p_draft->>'closing','sources',v_sources)::text,'UTF8')),'hex');
 if v_exists then
  update private.app_weekly_email_drafts set version=version+1,week_start=v_week,subject=v_subject,intro=p_draft->>'intro',closing=p_draft->>'closing',
   sources=v_sources,status='draft',content_hash=v_content_hash,reviewed_at=null,reviewed_by=null,updated_at=clock_timestamp(),updated_by=auth.uid()
   where id=p_id returning * into v_row;
 else
  insert into private.app_weekly_email_drafts(id,version,week_start,subject,intro,closing,sources,status,content_hash,created_by,updated_by,updated_at)
   values(p_id,1,v_week,v_subject,p_draft->>'intro',p_draft->>'closing',v_sources,'draft',v_content_hash,auth.uid(),auth.uid(),clock_timestamp()) returning * into v_row;
 end if;
 v_receipt:=jsonb_build_object('id',v_row.id,'version',v_row.version,'status','draft');
 insert into private.app_weekly_email_revisions(draft_id,version,snapshot,actor_id)
 values(v_row.id,v_row.version,to_jsonb(v_row)-array['created_at','created_by','updated_by','reviewed_by'],auth.uid());
 insert into private.app_weekly_email_receipts(actor_id,request_id,operation,payload_hash,receipt) values(auth.uid(),p_request_id,'save',v_payload_hash,v_receipt);
 insert into public.audit_log(actor_id,action,entity_type,entity_id) values(auth.uid(),case when v_exists then 'update' else 'insert' end,'app_weekly_email_drafts',p_id::text);
 return v_receipt;
end $$;

create function private.review_weekly_email_draft(p_request_id uuid,p_id uuid,p_expected_version integer,p_content_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row private.app_weekly_email_drafts%rowtype;v_saved private.app_weekly_email_receipts%rowtype;
 v_payload_hash text;v_refs jsonb;v_sources jsonb;v_receipt jsonb;
begin
 perform private.lock_weekly_email_actor(true);
 if p_request_id is null or p_id is null or p_expected_version is null or p_expected_version<1
  or p_content_hash is null or p_content_hash !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_WEEKLY_EMAIL_FIELDS' using errcode='22023';end if;
 v_payload_hash:=encode(sha256(convert_to(jsonb_build_object('operation','review','id',p_id,'expected_version',p_expected_version,'content_hash',p_content_hash)::text,'UTF8')),'hex');
 select * into v_saved from private.app_weekly_email_receipts where actor_id=auth.uid() and request_id=p_request_id;
 if found then
  if v_saved.operation<>'review' or v_saved.payload_hash<>v_payload_hash then raise exception 'WEEKLY_EMAIL_REQUEST_CONFLICT' using errcode='40001';end if;
  return v_saved.receipt;
 end if;
 select * into v_row from private.app_weekly_email_drafts where id=p_id for update;
 if not found then raise exception 'WEEKLY_EMAIL_NOT_FOUND' using errcode='P0002';end if;
 if v_row.version<>p_expected_version then raise exception 'WEEKLY_EMAIL_VERSION_CONFLICT' using errcode='40001';end if;
 if v_row.content_hash<>p_content_hash then raise exception 'WEEKLY_EMAIL_CONTENT_CHANGED' using errcode='40001';end if;
 if jsonb_array_length(v_row.sources)=0 and v_row.intro !~ '[^[:space:]]' and v_row.closing !~ '[^[:space:]]' then
  raise exception 'INVALID_WEEKLY_EMAIL_FIELDS' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',value->'id','version',value->'version') order by ord),'[]'::jsonb) into v_refs
 from jsonb_array_elements(v_row.sources) with ordinality s(value,ord);
 v_sources:=private.weekly_email_source_snapshot(v_refs,v_row.week_start);
 if v_sources<>v_row.sources then raise exception 'WEEKLY_EMAIL_SOURCE_CHANGED' using errcode='40001';end if;
 update private.app_weekly_email_drafts set version=version+1,status='reviewed',reviewed_at=clock_timestamp(),reviewed_by=auth.uid(),
  updated_at=clock_timestamp(),updated_by=auth.uid() where id=p_id returning * into v_row;
 v_receipt:=jsonb_build_object('id',v_row.id,'version',v_row.version,'status','reviewed');
 insert into private.app_weekly_email_revisions(draft_id,version,snapshot,actor_id)
 values(v_row.id,v_row.version,to_jsonb(v_row)-array['created_at','created_by','updated_by','reviewed_by'],auth.uid());
 insert into private.app_weekly_email_receipts(actor_id,request_id,operation,payload_hash,receipt) values(auth.uid(),p_request_id,'review',v_payload_hash,v_receipt);
 insert into public.audit_log(actor_id,action,entity_type,entity_id) values(auth.uid(),'update','app_weekly_email_drafts',p_id::text);
 return v_receipt;
end $$;

create function public.get_weekly_email_workspace(p_week_start date)
returns jsonb language sql stable security invoker set search_path='' as $$ select private.get_weekly_email_workspace(p_week_start) $$;
create function public.get_weekly_email_draft(p_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$ select private.get_weekly_email_draft(p_id) $$;
create function public.save_weekly_email_draft(p_request_id uuid,p_id uuid,p_expected_version integer,p_draft jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.save_weekly_email_draft(p_request_id,p_id,p_expected_version,p_draft) $$;
create function public.review_weekly_email_draft(p_request_id uuid,p_id uuid,p_expected_version integer,p_content_hash text)
returns jsonb language sql security invoker set search_path='' as $$ select private.review_weekly_email_draft(p_request_id,p_id,p_expected_version,p_content_hash) $$;
revoke all on function private.reject_weekly_email_history_change(),private.weekly_email_week(date),private.lock_weekly_email_actor(boolean),
 private.weekly_email_source_snapshot(jsonb,date),private.weekly_email_sources_current(jsonb,date),
 private.get_weekly_email_workspace(date),private.get_weekly_email_draft(uuid),private.save_weekly_email_draft(uuid,uuid,integer,jsonb),private.review_weekly_email_draft(uuid,uuid,integer,text),
 public.get_weekly_email_workspace(date),public.get_weekly_email_draft(uuid),public.save_weekly_email_draft(uuid,uuid,integer,jsonb),public.review_weekly_email_draft(uuid,uuid,integer,text)
 from public,anon,authenticated,service_role;
grant execute on function private.get_weekly_email_workspace(date),private.get_weekly_email_draft(uuid),private.save_weekly_email_draft(uuid,uuid,integer,jsonb),private.review_weekly_email_draft(uuid,uuid,integer,text),
 public.get_weekly_email_workspace(date),public.get_weekly_email_draft(uuid),public.save_weekly_email_draft(uuid,uuid,integer,jsonb),public.review_weekly_email_draft(uuid,uuid,integer,text) to authenticated;
commit;
