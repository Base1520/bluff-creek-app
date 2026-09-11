-- Optional, independently reviewed addition to the ten-file hosted baseline.
-- Does not remove accounts, People, care plans, prayers, history or receipts.
begin;

alter table public.app_connections
 add column guest_removed_at timestamptz,
 add column guest_removed_by uuid references auth.users(id) on delete restrict,
 add column guest_lifecycle_version integer not null default 1 check(guest_lifecycle_version>0),
 add constraint guest_removed_state check((guest_removed_at is null and guest_removed_by is null) or (guest_removed_at is not null and guest_removed_by is not null and status='archived'));
alter table public.app_submission_tasks add column guest_removed_at timestamptz,
 add constraint guest_removed_task_state check(guest_removed_at is null or (kind='guest_followup' and status='completed'));
alter table private.app_welcome_links add column guest_cancelled_at timestamptz;
create table private.guest_lifecycle_state (
 registration_id uuid primary key references public.app_connections(id) on delete restrict,
 previous_status text not null check(previous_status in('pending','reviewed','archived')),
 task_id uuid references public.app_submission_tasks(id) on delete restrict,
 task_status text check(task_status in('new','in_progress','completed')),
 task_completed_at timestamptz,
 task_completed_by uuid references auth.users(id) on delete restrict
);
create table private.guest_lifecycle_receipts (
 actor_id uuid not null references auth.users(id) on delete restrict,
 request_id uuid not null,
 payload jsonb not null,
 receipt jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 primary key(actor_id,request_id)
);
alter table private.guest_lifecycle_state enable row level security;
alter table private.guest_lifecycle_receipts enable row level security;
revoke all on private.guest_lifecycle_state,private.guest_lifecycle_receipts from public,anon,authenticated,service_role;

-- Existing submission/review RPCs cannot clear this marker. Their normal fields
-- are refused while removed; late welcome status bookkeeping remains possible.
create function private.guard_removed_guest_update()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if old.guest_removed_at is not null and new.guest_removed_at is not null
 and (to_jsonb(new)-array['welcome_email_status','updated_at']) is distinct from (to_jsonb(old)-array['welcome_email_status','updated_at']) then
  raise exception 'GUEST_REMOVED' using errcode='55000';
 end if;
 return new;
end $$;
create trigger guard_removed_guest before update on public.app_connections for each row execute function private.guard_removed_guest_update();
create function private.guard_removed_guest_task_update()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if old.guest_removed_at is not null and new.guest_removed_at is not null
 and (to_jsonb(new)-'notification_status') is distinct from (to_jsonb(old)-'notification_status') then
  raise exception 'GUEST_REMOVED' using errcode='55000';
 end if;
 return new;
end $$;
create trigger guard_removed_guest_task before update on public.app_submission_tasks for each row execute function private.guard_removed_guest_task_update();
create function private.keep_guest_lifecycle_receipt()
returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception 'IMMUTABLE_GUEST_LIFECYCLE_RECEIPT' using errcode='55000';end $$;
create trigger keep_guest_lifecycle_receipt before update or delete on private.guest_lifecycle_receipts for each row execute function private.keep_guest_lifecycle_receipt();
revoke all on function private.guard_removed_guest_update(),private.guard_removed_guest_task_update(),private.keep_guest_lifecycle_receipt() from public,anon,authenticated,service_role;

-- No new recipient can be enqueued while the source action is removed.
create or replace function private.intake_notice_targets(p_task_id uuid)
returns table(id uuid,email text) language sql stable security definer set search_path='' as $$
 select s.id,s.email from public.app_submission_tasks t cross join private.eligible_intake_staff() s
 where t.id=p_task_id and t.guest_removed_at is null and ((t.assigned_staff_user_id is not null and s.id=t.assigned_staff_user_id)
 or (t.assigned_staff_user_id is null and s.role='admin'))
$$;

create function private.set_guest_registration_removed(p_request_id uuid,p_id uuid,p_version integer,p_staff_version integer,p_lifecycle_version integer,p_removed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.app_connections%rowtype;v_task public.app_submission_tasks%rowtype;v_saved private.guest_lifecycle_receipts%rowtype;
 v_state private.guest_lifecycle_state%rowtype;v_payload jsonb;v_receipt jsonb;v_account uuid;v_now timestamptz:=clock_timestamp();
begin
 if private.current_staff_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 if p_request_id is null or p_id is null or p_removed is null or p_version is null or p_version<1 or p_staff_version is null or p_staff_version<1 or p_lifecycle_version is null or p_lifecycle_version<1 then
  raise exception 'INVALID_GUEST_LIFECYCLE_FIELDS' using errcode='22023';end if;
 -- Serialize actor receipts, including the same request accidentally used on two
 -- registrations. NOWAIT below prevents cycles with submission/worker locks.
 perform id from auth.users where id=auth.uid() for update;
 if private.current_staff_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 v_payload:=jsonb_build_object('id',p_id,'version',p_version,'staff_version',p_staff_version,'lifecycle_version',p_lifecycle_version,'removed',p_removed);
 select * into v_saved from private.guest_lifecycle_receipts where actor_id=auth.uid() and request_id=p_request_id;
 if found then
  if v_saved.payload is distinct from v_payload then raise exception 'GUEST_LIFECYCLE_REQUEST_CONFLICT' using errcode='40001';end if;
  return v_saved.receipt;
 end if;
 select auth_user_id into v_account from public.app_connections where id=p_id;
 if not found then raise exception 'GUEST_NOT_FOUND' using errcode='P0002';end if;
 begin
  perform id from auth.users where id=v_account for update nowait;
  select * into v_row from public.app_connections where id=p_id for update nowait;
  select * into v_task from public.app_submission_tasks where registration_id=p_id for update nowait;
  perform j.id from private.app_welcome_outbox j join private.app_welcome_links l on l.outbox_id=j.id where l.registration_id=p_id for update of j nowait;
  perform id from private.app_staff_notice_outbox where task_id=v_task.id order by id for update nowait;
 exception when lock_not_available then raise exception 'GUEST_DISPATCH_BUSY' using errcode='55P03';end;
 if v_row.version<>p_version or v_row.staff_version<>p_staff_version or v_row.guest_lifecycle_version<>p_lifecycle_version then
  raise exception 'GUEST_LIFECYCLE_VERSION_CONFLICT' using errcode='40001';end if;
 if (v_row.guest_removed_at is not null)=p_removed then raise exception 'GUEST_LIFECYCLE_VERSION_CONFLICT' using errcode='40001';end if;
 if p_removed and v_row.status='archived' then raise exception 'GUEST_LIFECYCLE_STATE_UNAVAILABLE' using errcode='55000';end if;
 if p_removed then
  -- A claimed HTTP request may already be outside PostgreSQL. Never describe
  -- that as cancelled; ask the operator to retry after its active lease ends.
  if exists(select 1 from private.app_welcome_outbox j join private.app_welcome_links l on l.outbox_id=j.id where l.registration_id=p_id and j.status='sending' and j.lease_until>clock_timestamp())
   or exists(select 1 from private.app_staff_notice_outbox where task_id=v_task.id and status='sending' and lease_until>clock_timestamp()) then
   raise exception 'GUEST_DISPATCH_BUSY' using errcode='55P03';end if;
  insert into private.guest_lifecycle_state(registration_id,previous_status,task_id,task_status,task_completed_at,task_completed_by)
  values(p_id,v_row.status,v_task.id,v_task.status,v_task.completed_at,v_task.completed_by)
  on conflict(registration_id) do update set previous_status=excluded.previous_status,task_id=excluded.task_id,task_status=excluded.task_status,task_completed_at=excluded.task_completed_at,task_completed_by=excluded.task_completed_by;
  update public.app_connections set guest_removed_at=v_now,guest_removed_by=auth.uid(),status='archived',staff_version=staff_version+1,guest_lifecycle_version=guest_lifecycle_version+1 where id=p_id returning * into v_row;
  if v_task.id is not null then
   update public.app_submission_tasks set guest_removed_at=v_now,status='completed',completed_at=coalesce(completed_at,v_now),completed_by=coalesce(completed_by,auth.uid()),version=version+1 where id=v_task.id returning * into v_task;
   update private.app_staff_notice_outbox set status='attention',error_code='guest_removed',lease_token=null,lease_until=null where task_id=v_task.id and status<>'sent';
   update public.app_submission_tasks set notification_status='attention' where id=v_task.id and notification_status<>'sent';
  end if;
  update private.app_welcome_links set guest_cancelled_at=coalesce(guest_cancelled_at,v_now) where registration_id=p_id;
  -- A welcome may be shared by multiple registrations with the same recipient.
  -- Suppress this link, cancel the job only if no active unsuppressed link needs it.
  update private.app_welcome_outbox j set status='attention',error_code='guest_removed',lease_token=null,lease_until=null
  where status<>'sent' and exists(select 1 from private.app_welcome_links l where l.outbox_id=j.id and l.registration_id=p_id)
   and not exists(select 1 from private.app_welcome_links l join public.app_connections c on c.id=l.registration_id where l.outbox_id=j.id and l.guest_cancelled_at is null and c.guest_removed_at is null);
  -- Do not leave a restored row advertising a queued welcome that was cancelled.
  update public.app_connections set welcome_email_status='attention' where id=p_id and welcome_email_status<>'sent';
 else
  select * into v_state from private.guest_lifecycle_state where registration_id=p_id;
  if not found or v_state.task_id is distinct from v_task.id then raise exception 'GUEST_LIFECYCLE_STATE_UNAVAILABLE' using errcode='55000';end if;
  update public.app_connections set guest_removed_at=null,guest_removed_by=null,status=v_state.previous_status,staff_version=staff_version+1,guest_lifecycle_version=guest_lifecycle_version+1 where id=p_id returning * into v_row;
  if v_task.id is not null then
   update public.app_submission_tasks set guest_removed_at=null,status=v_state.task_status,completed_at=v_state.task_completed_at,completed_by=v_state.task_completed_by,version=version+1 where id=v_task.id returning * into v_task;
  end if;
  -- Deliberately no enqueue, uncancel, rotation advance, or receipt deletion.
 end if;
 v_receipt:=jsonb_build_object('id',v_row.id,'version',v_row.version,'staff_version',v_row.staff_version,'lifecycle_version',v_row.guest_lifecycle_version,'removed',v_row.guest_removed_at is not null,'task_id',v_task.id,'task_version',v_task.version);
 insert into private.guest_lifecycle_receipts(actor_id,request_id,payload,receipt) values(auth.uid(),p_request_id,v_payload,v_receipt);
 return v_receipt;
end $$;

create function public.get_guest_lifecycle_readiness()
returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
 if not coalesce(private.current_staff_role() in('admin','editor'),false) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 return jsonb_build_object('version',1,'available',true);
end $$;
create function public.set_guest_registration_removed(p_request_id uuid,p_id uuid,p_version integer,p_staff_version integer,p_lifecycle_version integer,p_removed boolean)
returns jsonb language sql security invoker set search_path='' as $$
 select private.set_guest_registration_removed(p_request_id,p_id,p_version,p_staff_version,p_lifecycle_version,p_removed)
$$;
revoke all on function private.set_guest_registration_removed(uuid,uuid,integer,integer,integer,boolean),public.set_guest_registration_removed(uuid,uuid,integer,integer,integer,boolean),public.get_guest_lifecycle_readiness() from public,anon,authenticated,service_role;
grant execute on function private.set_guest_registration_removed(uuid,uuid,integer,integer,integer,boolean),public.set_guest_registration_removed(uuid,uuid,integer,integer,integer,boolean),public.get_guest_lifecycle_readiness() to authenticated;

-- Shared welcome claims require an active, unsuppressed registration link.
create or replace function private.claim_app_welcome_jobs(p_scope_user_id uuid,p_limit integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_now timestamptz:=clock_timestamp(); v_day date; v_quota integer; v_job private.app_welcome_outbox%rowtype; v_result jsonb:='[]'; v_count integer:=0;
begin
  if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_CLAIM_LIMIT' using errcode='22023'; end if;
  v_day:=(v_now at time zone 'UTC')::date;
  insert into private.app_welcome_daily_quota(utc_day) values(v_day) on conflict do nothing;
  select first_attempts into v_quota from private.app_welcome_daily_quota where utc_day=v_day for update;
  for v_job in select j.* from private.app_welcome_outbox j
    where ((j.status='queued' and j.next_attempt_at<=v_now) or (j.status='sending' and j.lease_until<=v_now))
      and (p_scope_user_id is null or exists(select 1 from private.app_welcome_links l join public.app_connections c on c.id=l.registration_id where l.outbox_id=j.id and c.auth_user_id=p_scope_user_id and c.guest_removed_at is null and l.guest_cancelled_at is null))
    order by j.first_attempt_at nulls last,j.created_at,j.id limit 100 for update skip locked
  loop
    if not exists(select 1 from private.app_welcome_links l join public.app_connections c on c.id=l.registration_id join auth.users u on u.id=c.auth_user_id
      where l.outbox_id=v_job.id and c.guest_removed_at is null and l.guest_cancelled_at is null and (p_scope_user_id is null or u.id=p_scope_user_id) and lower(btrim(u.email))=v_job.recipient_key
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


-- Own-account projection reports removal without staff metadata.
create or replace function private.get_my_app_connection()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_email text; v_profile jsonb;
begin
  v_email:=private.app_account_email();
  select jsonb_build_object('id',c.id,'first_name',c.first_name,'last_name',c.last_name,'email',v_email,'phone',c.phone,
    'preferred_contact',c.preferred_contact,'contact_permission',c.contact_permission,'sunday_school',c.sunday_school,
    'visit_status',c.visit_status,'first_visit_on',c.first_visit_on,
    'birth_date',c.birth_date,'membership_status',c.membership_status,'address_line1',c.address_line1,'address_line2',c.address_line2,'city',c.city,'state_region',c.state_region,'postal_code',c.postal_code,'family_members',c.family_members,
    'guest_removed',c.guest_removed_at is not null,'version',c.version,'submitted_at',c.submitted_at,'updated_at',c.updated_at)
  into v_profile from public.app_connections c where c.auth_user_id=auth.uid();
  return v_profile;
end $$;


commit;
