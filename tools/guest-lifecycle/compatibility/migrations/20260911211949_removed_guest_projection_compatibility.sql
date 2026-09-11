-- Optional compatibility ONLY after guest lifecycle + original attention + original
-- communication-preference packages have been separately reviewed for activation.
-- No original migration bytes, records, messages, policies or grants are changed.
begin;
do $$
begin
 if to_regprocedure('public.get_office_attention()') is null
  or to_regprocedure('private.get_office_attention()') is null
  or to_regprocedure('public.get_office_communication_audience()') is null
  or to_regprocedure('private.get_office_communication_audience()') is null
  or to_regprocedure('public.set_guest_registration_removed(uuid,uuid,integer,integer,integer,boolean)') is null
  or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_connections' and column_name='guest_removed_at' and data_type='timestamp with time zone')
  or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_submission_tasks' and column_name='guest_removed_at' and data_type='timestamp with time zone') then
  raise exception 'GUEST_PROJECTION_PREREQUISITES_REQUIRED' using errcode='55000';
 end if;
 -- Refuse overwriting unreviewed function-body drift. Reapplication of the exact
 -- compatibility definitions is harmless and explicitly accepted.
 if not exists(select 1 from pg_proc where oid='private.get_office_attention()'::regprocedure and md5(prosrc) in('135aa65f562311d6aaa2e0fdb50fdcef','beed6dc6e371f23dc6f17218ad10e876')) then
  raise exception 'GUEST_PROJECTION_SOURCE_CHANGED' using errcode='55000';
 end if;
 if not exists(select 1 from pg_proc where oid='private.get_office_communication_audience()'::regprocedure and md5(prosrc) in('0f0f3be0ff83a4c9ca8f1f5b64376e4c','6d6ba10728176101c23f84c19d6a71df')) then
  raise exception 'GUEST_PROJECTION_SOURCE_CHANGED' using errcode='55000';
 end if;
end $$;

create or replace function private.get_office_attention()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
 v_now timestamptz:=statement_timestamp();
 v_today date:=(statement_timestamp() at time zone 'America/Chicago')::date;
 v_items jsonb;
begin
 if not coalesce(private.current_staff_role() in('admin','editor'),false) then
  raise exception 'STAFF_REQUIRED' using errcode='42501';
 end if;

 -- STABLE functions use the calling statement's snapshot. Aggregate a bounded
 -- sentinel from that same result rather than counting and re-reading pages.
 with task_state as (
  select t.*,case when to_jsonb(t)->>'deacon_slot' ~ '^[1-5]$'
    then (to_jsonb(t)->>'deacon_slot')::integer end attention_deacon_slot,
   exists(select 1 from private.eligible_intake_staff() s where s.id=t.assigned_staff_user_id) assigned_eligible,
   n.notice_attention,n.notice_waiting
  from public.app_submission_tasks t
  cross join lateral (
   select count(s.id)=0 or coalesce(bool_or(j.id is null or j.status='attention'),false) notice_attention,
    coalesce(bool_or(j.created_at<=v_now-interval '30 minutes'
      and (j.status='queued' or (j.status='sending' and j.lease_until<=v_now))),false) notice_waiting
   from private.intake_notice_targets(t.id) s
   left join private.app_staff_notice_outbox j on j.task_id=t.id
    and j.recipient_staff_user_id=s.id and j.recipient_key=lower(s.email)
  ) n
  where t.guest_removed_at is null and not exists(
   select 1 from public.app_connections c where c.id=t.registration_id
    and (c.guest_removed_at is not null or c.status='archived'))
 ), task_reasons as (
  select t.*,array_remove(array[
   case when status<>'completed' and due_on<v_today then 'intake_overdue' end,
   case when status<>'completed' and due_on=v_today then 'intake_due_today' end,
   case when status<>'completed' and assigned_staff_user_id is null and attention_deacon_slot is null then 'intake_unassigned' end,
   case when status<>'completed' and not assigned_eligible
     and (assigned_staff_user_id is not null or attention_deacon_slot is not null) then 'recipient_setup' end,
   case when notice_attention then 'notice_attention' end,
   case when notice_waiting then 'notice_waiting' end
  ],null)::text[] reasons
  from task_state t
 ), task_items as (
  select 'intake:'||id::text key,
   jsonb_build_object('key','intake:'||id::text,
    'category',case when reasons&&array['intake_overdue','intake_due_today','intake_unassigned','recipient_setup'] then 'intake' else 'mail' end,
    'source_type','intake','source_id',id,'contact_id',null,'care_role',null,
    'title',case when status='completed' then 'Completed ' else '' end||
      case when kind='guest_followup' then case when status='completed' then 'guest follow-up' else 'Guest follow-up' end
           else case when status='completed' then 'private prayer care' else 'Private prayer care' end end,
    'owner_label',case when attention_deacon_slot is not null then 'Deacon '||attention_deacon_slot::text
      when assigned_staff_user_id is not null then 'Assigned staff' else 'Office queue' end,
    'due_on',case when status<>'completed' then due_on end,'reasons',to_jsonb(reasons)) item
  from task_reasons where cardinality(reasons)>0
 ), welcome_items as (
  -- A deduplicated recipient job can be linked to more than one registration.
  -- Keep one issue per linked registration; never expose a job or recipient ID.
  select 'welcome:'||l.registration_id::text key,
   jsonb_build_object('key','welcome:'||l.registration_id::text,'category','mail',
    'source_type','registration','source_id',l.registration_id,'contact_id',null,'care_role',null,
    'title','Guest welcome email','owner_label','Office queue','due_on',null,
    'reasons',jsonb_build_array(case when j.status='attention' then 'welcome_attention' else 'welcome_waiting' end)) item
  from private.app_welcome_links l join private.app_welcome_outbox j on j.id=l.outbox_id
  join public.app_connections c on c.id=l.registration_id
  where c.guest_removed_at is null and c.status<>'archived'
   and (j.status='attention' or (j.created_at<=v_now-interval '30 minutes'
   and (j.status='queued' or (j.status='sending' and j.lease_until<=v_now))))
 ), bounded as (
  select key,item from (select * from task_items union all select * from welcome_items) all_items
  order by key limit 5001
 )
 select coalesce(jsonb_agg(item order by key),'[]'::jsonb) into v_items from bounded;

 if jsonb_array_length(v_items)>5000 then
  raise exception 'OFFICE_ATTENTION_LIMIT_EXCEEDED' using errcode='54000';
 end if;
 return jsonb_build_object('version',1,'generated_at',v_now,'today',v_today,'waiting_minutes',30,'total',jsonb_array_length(v_items),'items',v_items);
end $$;

create or replace function private.get_office_communication_audience()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_total integer;v_rows jsonb;
begin
 if not coalesce(private.current_staff_role() in('admin','editor'),false) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 select count(*) into v_total from(select id from public.app_connections where guest_removed_at is null and status<>'archived' limit 5001) c;
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
  where c.guest_removed_at is null and c.status<>'archived'
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

commit;
