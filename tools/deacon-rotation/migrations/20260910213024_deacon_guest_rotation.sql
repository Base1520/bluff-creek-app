-- Proposed addition after the ten recorded Office migrations.
-- Fixed empty slots only. No names, accounts, roles or historical task backfill.
begin;

create table private.app_deacon_slots (
 slot integer primary key check(slot between 1 and 5),
 display_name text check(display_name is null or (display_name=btrim(display_name) and char_length(display_name) between 1 and 100 and display_name !~ '[[:cntrl:]<>]')),
 assigned_staff_user_id uuid references auth.users(id) on delete restrict,
 version integer not null default 1 check(version>=1)
);
create table private.app_deacon_rotation (
 id boolean primary key default true check(id),
 next_slot integer not null default 1 check(next_slot between 1 and 5)
);
insert into private.app_deacon_slots(slot) values(1),(2),(3),(4),(5);
insert into private.app_deacon_rotation(id) values(true);
alter table private.app_deacon_slots enable row level security;
alter table private.app_deacon_rotation enable row level security;
revoke all on private.app_deacon_slots,private.app_deacon_rotation from public,anon,authenticated,service_role;
alter table public.app_submission_tasks add column deacon_slot integer references private.app_deacon_slots(slot) on delete restrict
 check(deacon_slot is null or (deacon_slot between 1 and 5 and kind='guest_followup'));
create index app_submission_tasks_deacon_open_idx on public.app_submission_tasks(deacon_slot,id) where status<>'completed';

create or replace function private.create_intake_task(p_kind text,p_source_id uuid,p_account_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_assigned uuid;v_task uuid;v_slot integer;
begin
 if p_kind='guest_followup' then
  if not exists(select 1 from public.app_connections where id=p_source_id and auth_user_id=p_account_id) then raise exception 'INVALID_TASK_SOURCE' using errcode='22023';end if;
  select next_slot into v_slot from private.app_deacon_rotation where id=true for update;
  if not found then raise exception 'DEACON_ROTATION_UNAVAILABLE' using errcode='55000';end if;
  perform slot from private.app_deacon_slots where slot=v_slot for update;
  if not found then raise exception 'DEACON_ROTATION_UNAVAILABLE' using errcode='55000';end if;
  select s.id into v_assigned from private.app_deacon_slots d join private.eligible_intake_staff() s on s.id=d.assigned_staff_user_id where d.slot=v_slot;
  update private.app_deacon_rotation set next_slot=case when v_slot=5 then 1 else v_slot+1 end where id=true;
 elsif p_kind='prayer_care' then
  if not exists(select 1 from public.office_prayer_requests where id=p_source_id and submitted_auth_user_id=p_account_id and source='app') then raise exception 'INVALID_TASK_SOURCE' using errcode='22023';end if;
  select s.id into v_assigned from private.app_intake_routes r join private.eligible_intake_staff() s on s.id=r.assigned_staff_user_id where r.kind=p_kind;
 else raise exception 'INVALID_TASK_KIND' using errcode='22023';end if;
 insert into public.app_submission_tasks(kind,registration_id,prayer_request_id,submitted_auth_user_id,due_on,deacon_slot,assigned_staff_user_id,routing)
 values(p_kind,case when p_kind='guest_followup' then p_source_id end,case when p_kind='prayer_care' then p_source_id end,p_account_id,
 (now() at time zone 'America/Chicago')::date+case when p_kind='guest_followup' then 2 else 0 end,v_slot,v_assigned,case when v_assigned is null then 'office' else 'staff' end)
 returning id into v_task;
 perform private.enqueue_intake_notices(v_task);
end $$;

create or replace function private.get_intake_settings()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not coalesce(private.current_staff_role() in('admin','editor'),false) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 return jsonb_build_object('version',1,'routes',(select jsonb_agg(to_jsonb(r) order by r.kind) from private.app_intake_routes r),
 'staff',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'label',s.email) order by s.email,s.id),'[]'::jsonb) from private.eligible_intake_staff() s),
 'deacons',(select jsonb_agg(to_jsonb(d) order by d.slot) from private.app_deacon_slots d),
 'deacon_rotation',(select jsonb_build_object('enabled',true,'next_slot',r.next_slot) from private.app_deacon_rotation r where r.id=true));
end $$;

create or replace function private.set_intake_route(p_kind text,p_version integer,p_assigned_staff_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row private.app_intake_routes%rowtype;
begin
 if private.current_staff_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 if p_kind='guest_followup' then raise exception 'GUEST_DEACON_ROTATION_REQUIRED' using errcode='22023';end if;
 if p_kind is null or p_kind<>'prayer_care' or (p_assigned_staff_user_id is not null and not exists(select 1 from private.eligible_intake_staff() where id=p_assigned_staff_user_id)) then raise exception 'INVALID_ROUTE_FIELDS' using errcode='22023';end if;
 select * into v_row from private.app_intake_routes where kind=p_kind for update;
 if p_version is null or p_version<>v_row.version then raise exception 'ROUTE_VERSION_CONFLICT' using errcode='40001';end if;
 update private.app_intake_routes set assigned_staff_user_id=p_assigned_staff_user_id,version=version+1 where kind=p_kind returning * into v_row;
 return jsonb_build_object('kind',v_row.kind,'version',v_row.version);
end $$;

create function private.set_deacon_slot(p_slot integer,p_version integer,p_display_name text,p_assigned_staff_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_slot private.app_deacon_slots%rowtype;v_task public.app_submission_tasks%rowtype;v_name text;v_assigned uuid;
begin
 if private.current_staff_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 if p_slot is null or p_slot not between 1 and 5 or (p_display_name is not null and (char_length(p_display_name)>100 or p_display_name ~ '[[:cntrl:]<>]')) then raise exception 'INVALID_DEACON_SLOT' using errcode='22023';end if;
 v_name:=nullif(btrim(p_display_name),'');
 perform id from private.app_deacon_rotation where id=true for update;
 if not found then raise exception 'DEACON_ROTATION_UNAVAILABLE' using errcode='55000';end if;
 select * into v_slot from private.app_deacon_slots where slot=p_slot for update;
 if not found then raise exception 'DEACON_ROTATION_UNAVAILABLE' using errcode='55000';end if;
 if p_version is null or p_version<>v_slot.version then raise exception 'DEACON_SLOT_VERSION_CONFLICT' using errcode='40001';end if;
 if p_assigned_staff_user_id is not null then
  select id into v_assigned from private.eligible_intake_staff() where id=p_assigned_staff_user_id;
  if not found then raise exception 'INVALID_DEACON_ASSIGNEE' using errcode='22023';end if;
 end if;
 -- The unchanged worker can hold several tasks in job order. Pre-lock this
 -- entire set without waiting, before any changes, to avoid a task-order cycle.
 begin
  perform id from public.app_submission_tasks where deacon_slot=p_slot and status<>'completed' order by id for update nowait;
 exception when lock_not_available then
  raise exception 'DEACON_ACTIONS_BUSY' using errcode='55P03';
 end;
 update private.app_deacon_slots set display_name=v_name,assigned_staff_user_id=p_assigned_staff_user_id,version=version+1 where slot=p_slot returning * into v_slot;
 for v_task in select * from public.app_submission_tasks where deacon_slot=p_slot and status<>'completed' order by id
 loop
  if v_task.assigned_staff_user_id is distinct from v_assigned then
   update public.app_submission_tasks set assigned_staff_user_id=v_assigned,routing=case when v_assigned is null then 'office' else 'staff' end,version=version+1 where id=v_task.id;
   -- Existing notice jobs stay immutable; only a previously unseen target is added.
   perform private.enqueue_intake_notices(v_task.id);
  end if;
 end loop;
 insert into public.audit_log(actor_id,action,entity_type,entity_id)
 values(auth.uid(),'update','app_deacon_slots',v_slot.slot::text||'/v'||v_slot.version::text);
 return jsonb_build_object('slot',v_slot.slot,'version',v_slot.version);
end $$;

create or replace function private.update_intake_task(p_id uuid,p_version integer,p_changes jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.app_submission_tasks%rowtype;v_due date;v_assigned uuid;v_requested uuid;v_status text;v_slot integer;v_changed boolean;
begin
 if not coalesce(private.current_staff_role() in('admin','editor'),false) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 if jsonb_typeof(p_changes) is distinct from 'object' or p_changes='{}'::jsonb or (p_changes-array['due_on','status','assigned_staff_user_id','deacon_slot'])<>'{}'::jsonb
 or (p_changes?'status' and (jsonb_typeof(p_changes->'status')<>'string' or p_changes->>'status' not in('new','in_progress','completed')))
 or (p_changes?'assigned_staff_user_id' and jsonb_typeof(p_changes->'assigned_staff_user_id') not in('string','null'))
 or (p_changes?'deacon_slot' and jsonb_typeof(p_changes->'deacon_slot') not in('number','null'))
 or (p_changes->>'deacon_slot' is not null and p_changes->>'deacon_slot' !~ '^[1-5]$') then raise exception 'INVALID_TASK_FIELDS' using errcode='22023';end if;
 if p_changes?'due_on' then v_due:=private.app_intake_date(p_changes->'due_on');if v_due is null then raise exception 'INVALID_TASK_DATE' using errcode='22023';end if;end if;
 if p_changes->>'assigned_staff_user_id' is not null then
  if p_changes->>'assigned_staff_user_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_TASK_ASSIGNEE' using errcode='22023';end if;
  v_requested:=(p_changes->>'assigned_staff_user_id')::uuid;
 end if;
 -- All staff task overrides serialize with rotation/slot edits before task locks.
 perform id from private.app_deacon_rotation where id=true for update;
 if not found then raise exception 'DEACON_ROTATION_UNAVAILABLE' using errcode='55000';end if;
 select * into v_row from public.app_submission_tasks where id=p_id;
 if not found then raise exception 'TASK_NOT_FOUND' using errcode='P0002';end if;
 v_slot:=case when p_changes?'deacon_slot' then (p_changes->>'deacon_slot')::integer else v_row.deacon_slot end;
 if v_slot is not null then
  if v_row.kind<>'guest_followup' then raise exception 'INVALID_TASK_DEACON_SLOT' using errcode='22023';end if;
  perform slot from private.app_deacon_slots where slot=v_slot for update;
  if not found then raise exception 'DEACON_ROTATION_UNAVAILABLE' using errcode='55000';end if;
 end if;
 select * into v_row from public.app_submission_tasks where id=p_id for update;
 if p_version is null or p_version<>v_row.version then raise exception 'TASK_VERSION_CONFLICT' using errcode='40001';end if;
 v_status:=coalesce(p_changes->>'status',v_row.status);
 if v_slot is not null then
  if v_row.status='completed' and v_status='completed' and not(p_changes?'deacon_slot') then
   -- A later roster change must not rewrite the recorded completed destination.
   v_assigned:=v_row.assigned_staff_user_id;
  else
   select s.id into v_assigned from private.app_deacon_slots d join private.eligible_intake_staff() s on s.id=d.assigned_staff_user_id where d.slot=v_slot;
  end if;
  if not(p_changes?'deacon_slot') and p_changes?'assigned_staff_user_id' and v_requested is distinct from v_row.assigned_staff_user_id then
   raise exception 'DEACON_SLOT_OWNER_REQUIRED' using errcode='22023';
  elsif p_changes?'deacon_slot' and v_requested is not null and v_requested is distinct from v_assigned then
   raise exception 'DEACON_SLOT_OWNER_REQUIRED' using errcode='22023';
  end if;
 else
  v_assigned:=case when p_changes?'assigned_staff_user_id' then v_requested else v_row.assigned_staff_user_id end;
  if p_changes?'assigned_staff_user_id' and v_assigned is not null and not exists(select 1 from private.eligible_intake_staff() where id=v_assigned) then raise exception 'INVALID_TASK_ASSIGNEE' using errcode='22023';end if;
 end if;
 v_changed:=v_assigned is distinct from v_row.assigned_staff_user_id;
 update public.app_submission_tasks set due_on=coalesce(v_due,due_on),status=v_status,deacon_slot=v_slot,assigned_staff_user_id=v_assigned,
 routing=case when v_assigned is null then 'office' else 'staff' end,version=version+1,
 completed_at=case when v_status='completed' then coalesce(completed_at,clock_timestamp()) end,
 completed_by=case when v_status='completed' then coalesce(completed_by,auth.uid()) end
 where id=p_id returning * into v_row;
 if v_changed then perform private.enqueue_intake_notices(p_id);end if;
 return jsonb_build_object('id',v_row.id,'version',v_row.version);
end $$;

create function public.set_deacon_slot(p_slot integer,p_version integer,p_display_name text,p_assigned_staff_user_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.set_deacon_slot(p_slot,p_version,p_display_name,p_assigned_staff_user_id) $$;
revoke all on function private.set_deacon_slot(integer,integer,text,uuid),public.set_deacon_slot(integer,integer,text,uuid) from public,anon,authenticated,service_role;
grant execute on function private.set_deacon_slot(integer,integer,text,uuid),public.set_deacon_slot(integer,integer,text,uuid) to authenticated;
-- Replaced functions retain their reviewed ownership, ACL and empty search path.
commit;
