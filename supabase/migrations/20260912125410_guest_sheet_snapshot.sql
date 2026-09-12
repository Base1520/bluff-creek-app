-- Proposed only. CLI-generated filename; no data export or sheet setup on apply.
begin;
create table private.app_guest_sheet_settings (
 id boolean primary key default true check(id),
 version integer not null default 1 check(version>0),
 sheet_url text check(sheet_url is null or sheet_url ~ '^https://docs[.]google[.]com/spreadsheets/d/[A-Za-z0-9_-]{20,160}/edit$')
);
insert into private.app_guest_sheet_settings(id) values(true);
alter table private.app_guest_sheet_settings enable row level security;
revoke all on private.app_guest_sheet_settings from public,anon,authenticated,service_role;

create function private.get_guest_sheet_settings()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
 if not coalesce(private.current_staff_role() in('admin','editor'),false) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 select jsonb_build_object('version',1,'settings_version',s.version,'sheet_url',s.sheet_url) into v_result from private.app_guest_sheet_settings s where id=true;
 if v_result is null then raise exception 'GUEST_SHEET_UNAVAILABLE' using errcode='55000';end if;
 return v_result;
end $$;
create function private.set_guest_sheet_settings(p_version integer,p_sheet_url text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row private.app_guest_sheet_settings%rowtype;
begin
 if private.current_staff_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 if p_version is null or p_version<1 or (p_sheet_url is not null and p_sheet_url !~ '^https://docs[.]google[.]com/spreadsheets/d/[A-Za-z0-9_-]{20,160}/edit$') then raise exception 'INVALID_GUEST_SHEET_SETTINGS' using errcode='22023';end if;
 select * into v_row from private.app_guest_sheet_settings where id=true for update;
 if not found then raise exception 'GUEST_SHEET_UNAVAILABLE' using errcode='55000';end if;
 if v_row.version<>p_version then raise exception 'GUEST_SHEET_VERSION_CONFLICT' using errcode='40001';end if;
 update private.app_guest_sheet_settings set version=version+1,sheet_url=p_sheet_url where id=true;
 return private.get_guest_sheet_settings();
end $$;

create function private.get_guest_sheet_snapshot()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_rows jsonb;v_slots jsonb:='{}'::jsonb;
begin
 -- The SQL role comes from PostgREST, never from user-editable JWT metadata.
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'SERVICE_REQUIRED' using errcode='42501';end if;
 -- Optional deacon extension. Fixed query only; caller supplies no identifiers/SQL.
 if exists(select 1 from information_schema.tables where table_schema='private' and table_name='app_deacon_slots') then
  execute 'select coalesce(jsonb_object_agg(slot::text,display_name),''{}''::jsonb) from private.app_deacon_slots' into v_slots;
 end if;
 select coalesce(jsonb_agg(r.cells order by r.submitted_at,r.id),'[]'::jsonb) into v_rows from (
  select c.id,c.submitted_at,jsonb_build_array(
   to_char(c.submitted_at at time zone 'America/Chicago','YYYY-MM-DD'),c.first_name,c.last_name,c.email,coalesce(c.phone,''),c.preferred_contact,
   case when c.contact_permission then 'Yes' else 'No' end,c.membership_status,c.visit_status,coalesce(c.first_visit_on::text,''),coalesce(c.staff_visit_on::text,''),
   coalesce(t.due_on::text,c.follow_up_on::text,''),coalesce(t.status,c.follow_up_status),
   case when to_jsonb(t)->>'deacon_slot' is not null then 'Deacon '||(to_jsonb(t)->>'deacon_slot')||coalesce(' — '||nullif(v_slots->>(to_jsonb(t)->>'deacon_slot'),''),'')
    when t.assigned_staff_user_id is not null then case when s.id is not null then s.email else 'Assigned staff — unavailable' end
    else 'Office queue' end,
   case c.welcome_email_status when 'sent' then 'Provider accepted' when 'sending' then 'Processing' when 'queued' then 'Queued' else 'Needs attention' end,
   c.status,c.id::text,to_char(c.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) cells
  from public.app_connections c
  left join public.app_submission_tasks t on t.registration_id=c.id and t.kind='guest_followup' and to_jsonb(t)->>'guest_removed_at' is null
  left join private.eligible_intake_staff() s on s.id=t.assigned_staff_user_id
  where c.status<>'archived' and to_jsonb(c)->>'guest_removed_at' is null
  order by c.submitted_at,c.id limit 5001
 ) r;
 if jsonb_array_length(v_rows)>5000 then raise exception 'GUEST_SHEET_LIMIT_EXCEEDED' using errcode='54000';end if;
 return jsonb_build_object('version',1,'generated_at',to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'total',jsonb_array_length(v_rows),'headers',jsonb_build_array('Signup date','First name','Last name','Email','Phone','Preferred contact','Permission to contact','Membership (self-reported)','Visit status','First visit','Confirmed visit','Next follow-up','Follow-up status','Assigned staff','Welcome email','Review status','Record ID','Updated at'),'rows',v_rows);
end $$;
create function public.get_guest_sheet_snapshot() returns jsonb language sql stable security invoker set search_path='' as $$select private.get_guest_sheet_snapshot()$$;
create function public.get_guest_sheet_settings() returns jsonb language sql stable security invoker set search_path='' as $$select private.get_guest_sheet_settings()$$;
create function public.set_guest_sheet_settings(p_version integer,p_sheet_url text) returns jsonb language sql security invoker set search_path='' as $$select private.set_guest_sheet_settings(p_version,p_sheet_url)$$;
revoke all on function private.get_guest_sheet_snapshot(),public.get_guest_sheet_snapshot(),private.get_guest_sheet_settings(),public.get_guest_sheet_settings(),private.set_guest_sheet_settings(integer,text),public.set_guest_sheet_settings(integer,text) from public,anon,authenticated,service_role;
grant execute on function private.get_guest_sheet_snapshot(),public.get_guest_sheet_snapshot() to service_role;
grant execute on function private.get_guest_sheet_settings(),public.get_guest_sheet_settings(),private.set_guest_sheet_settings(integer,text),public.set_guest_sheet_settings(integer,text) to authenticated;
commit;
