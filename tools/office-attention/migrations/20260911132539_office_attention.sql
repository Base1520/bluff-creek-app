-- Proposed read-only Office attention projection after the ten recorded migrations.
-- No task, notification, recipient, preference, role or scheduling mutation.
begin;

create function private.get_office_attention()
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
  where j.status='attention' or (j.created_at<=v_now-interval '30 minutes'
   and (j.status='queued' or (j.status='sending' and j.lease_until<=v_now)))
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

create function public.get_office_attention()
returns jsonb language sql stable security invoker set search_path='' as $$
 select private.get_office_attention()
$$;
revoke all on function private.get_office_attention(),public.get_office_attention() from public,anon,authenticated,service_role;
grant execute on function private.get_office_attention(),public.get_office_attention() to authenticated;

commit;
