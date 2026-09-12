-- Prepared read-only Office controls. Apply only after the two separately
-- reviewed reminder migrations. No recipients, settings, jobs or source rows
-- are changed, and no transport or schedule is enabled by these read RPCs.
begin;

do $$ begin
 if to_regclass('private.care_reminder_jobs') is null
 or to_regprocedure('private.get_care_reminder_settings()') is null
 or to_regprocedure('private.get_care_reminder_readiness()') is null
 or to_regprocedure('private.resolve_care_reminder_job(uuid,uuid,integer,text)') is null then
  raise exception 'CARE_REMINDER_PREREQUISITES_REQUIRED' using errcode='55000';
 end if;
end $$;

create function private.get_care_reminder_workspace()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_today date:=(statement_timestamp() at time zone 'America/Chicago')::date;
 v_settings jsonb;v_readiness jsonb;v_sources jsonb;v_staff jsonb;
begin
 if private.current_staff_role() is distinct from 'admin'::public.staff_role then
  raise exception 'CARE_REMINDER_ADMIN_REQUIRED' using errcode='42501';
 end if;
 v_settings:=private.get_care_reminder_settings();
 v_readiness:=private.get_care_reminder_readiness();
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'label',s.email) order by s.email,s.id),'[]'::jsonb)
 into v_staff from private.eligible_intake_staff() s;

 -- active describes the current source, not permission to send. Binding
 -- approval, enabled state, lifecycle, owner and delivery eligibility are
 -- still checked by the unchanged source/queue helpers. Include every bound
 -- row, even missing or inactive, so an administrator can review drift.
 with care as (
  select 'care_plan'::text source_type,coalesce(p.id,b.source_id) source_id,
   p.version source_version,null::integer lifecycle_version,p.contact_id,
   case when c.id is null then 'Unavailable care plan'
    else btrim(concat_ws(' ',c.first_name,c.last_name)) end label,
   p.care_role,coalesce(nullif(btrim(p.assigned_to),''),'Unassigned') owner_label,
   b.owner_user_id assigned_staff_user_id,p.one_time,
   coalesce(not p.paused and c.status in('active','visitor') and not(p.one_time and exists(
    select 1 from public.care_visits v where v.contact_id=p.contact_id and v.care_role=p.care_role
     and v.outcome='contacted' and v.contacted_on between p.started_on and v_today)),false) active,
   b.source_id is not null bound
  from public.care_assignments p
  full join (select * from private.care_reminder_bindings where source_type='care_plan') b on b.source_id=p.id
  left join public.contacts c on c.id=p.contact_id
 ), guests as (
  select 'guest_task'::text source_type,coalesce(t.id,b.source_id) source_id,
   t.version source_version,c.guest_lifecycle_version lifecycle_version,c.contact_id,
   case when c.id is null then 'Unavailable guest task'
    else btrim(concat_ws(' ',c.first_name,c.last_name)) end label,
   'welcome'::text care_role,
   case when t.assigned_staff_user_id is null then 'Office queue'
    else coalesce((select s.email from private.eligible_intake_staff() s where s.id=t.assigned_staff_user_id),'Unavailable staff') end owner_label,
   t.assigned_staff_user_id,true one_time,
   coalesce(t.kind='guest_followup' and t.status<>'completed' and t.guest_removed_at is null
    and c.id is not null and c.guest_removed_at is null and c.status<>'archived',false) active,
   b.source_id is not null bound
  from (select * from public.app_submission_tasks where kind='guest_followup') t
  full join (select * from private.care_reminder_bindings where source_type='guest_task') b on b.source_id=t.id
  left join public.app_connections c on c.id=t.registration_id
 ), combined as (
  select * from care where active or bound
  union all select * from guests where active or bound
 ), bounded as (
  select * from combined order by source_type,source_id limit 5001
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'source_type',s.source_type,'source_id',s.source_id,'source_version',s.source_version,
  'lifecycle_version',s.lifecycle_version,'contact_id',s.contact_id,'label',s.label,
  'care_role',s.care_role,'owner_label',s.owner_label,'assigned_staff_user_id',s.assigned_staff_user_id,
  'one_time',s.one_time,'active',s.active) order by s.source_type,s.source_id),'[]'::jsonb)
 into v_sources from bounded s;
 if jsonb_array_length(v_sources)>5000 then
  raise exception 'CARE_REMINDER_SOURCE_LIMIT' using errcode='54000';
 end if;
 return jsonb_build_object('version',1,'generated_at',statement_timestamp(),'today',v_today,
  'settings',v_settings,'readiness',v_readiness,'eligible_staff',v_staff,'sources',v_sources);
end $$;

create function private.get_care_reminder_jobs(p_filter text default 'attention',
 p_before_created_at timestamptz default null,p_before_id uuid default null,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_total bigint;v_counts jsonb;v_items jsonb;v_more boolean;v_cursor jsonb;
begin
 if private.current_staff_role() is distinct from 'admin'::public.staff_role then
  raise exception 'CARE_REMINDER_ADMIN_REQUIRED' using errcode='42501';
 end if;
 if p_filter is null or p_filter not in('attention','all') or p_limit is null or p_limit<1 or p_limit>100
 or ((p_before_created_at is null)<>(p_before_id is null))
 or (p_before_created_at is not null and not isfinite(p_before_created_at)) then
  raise exception 'CARE_REMINDER_JOBS_QUERY_INVALID' using errcode='22023';
 end if;
 if not exists(select 1 from private.care_reminder_settings where id) then
  raise exception 'CARE_REMINDER_SETTINGS_MISSING' using errcode='55000';
 end if;
 -- Counts and this page share one statement snapshot. A later page is a fresh
 -- snapshot: new jobs/status changes require refreshing page one. The keyset
 -- avoids offset skips/duplicates; it is not a cross-request snapshot promise.
 select jsonb_build_object('queued',count(*) filter(where status='queued'),
  'sending',count(*) filter(where status='sending'),'accepted',count(*) filter(where status='accepted'),
  'failed',count(*) filter(where status='failed'),'uncertain',count(*) filter(where status='uncertain'),
  'cancelled',count(*) filter(where status='cancelled')),
  count(*) filter(where p_filter='all' or status in('queued','sending','failed','uncertain'))
 into v_counts,v_total from private.care_reminder_jobs;
 with page as (
  select j.* from private.care_reminder_jobs j
  where (p_filter='all' or j.status in('queued','sending','failed','uncertain'))
   and (p_before_created_at is null or (j.created_at,j.id)<(p_before_created_at,p_before_id))
  order by j.created_at desc,j.id desc limit p_limit+1
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',j.id,'version',j.version,'status',j.status,
  'created_at',j.created_at,'planned_on',j.planned_on,'next_attempt_at',j.next_attempt_at,
  'attempts',j.attempts,'error_code',j.error_code,'recipient_user_ids',j.recipient_user_ids,
  'source_count',jsonb_array_length(j.source_refs),
  'hold_active',exists(select 1 from private.care_reminder_destination_holds h where h.destination_key=j.destination_key and h.active),
  'can_resolve',j.status in('queued','failed','uncertain')) order by j.created_at desc,j.id desc),'[]'::jsonb)
 into v_items from page j;
 v_more:=jsonb_array_length(v_items)>p_limit;
 if v_more then v_items:=v_items-p_limit;end if;
 v_cursor:=case when v_more then jsonb_build_object('created_at',v_items->(p_limit-1)->'created_at','id',v_items->(p_limit-1)->'id') else null end;
 return jsonb_build_object('version',1,'generated_at',statement_timestamp(),'total',v_total,
  'countsByStatus',v_counts,'items',v_items,'has_more',v_more,'next_cursor',v_cursor);
end $$;

create function public.get_care_reminder_workspace()
returns jsonb language sql stable security invoker set search_path='' as $$select private.get_care_reminder_workspace()$$;
create function public.get_care_reminder_jobs(p_filter text default 'attention',
 p_before_created_at timestamptz default null,p_before_id uuid default null,p_limit integer default 50)
returns jsonb language sql stable security invoker set search_path='' as $$
 select private.get_care_reminder_jobs(p_filter,p_before_created_at,p_before_id,p_limit)
$$;
revoke all on function private.get_care_reminder_workspace(),public.get_care_reminder_workspace(),
 private.get_care_reminder_jobs(text,timestamptz,uuid,integer),public.get_care_reminder_jobs(text,timestamptz,uuid,integer)
 from public,anon,authenticated,service_role;
grant execute on function private.get_care_reminder_workspace(),public.get_care_reminder_workspace(),
 private.get_care_reminder_jobs(text,timestamptz,uuid,integer),public.get_care_reminder_jobs(text,timestamptz,uuid,integer)
 to authenticated;
commit;
