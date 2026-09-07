-- Personal leadership follow-ups. Apply after the existing office migrations.
-- CLI-generated migration; prepared locally with synthetic tests only.
begin;

create table public.leader_followups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  display_name text not null check (char_length(display_name) between 1 and 160 and btrim(display_name) <> ''),
  leadership_role text not null check (leadership_role in ('deacon', 'sunday_school', 'committee', 'council', 'other')),
  team_name text check (char_length(team_name) <= 160),
  cadence_months integer check (cadence_months between 1 and 12),
  cadence_days integer check (cadence_days between 1 and 365),
  first_due_on date not null,
  last_contact_on date,
  snoozed_until date,
  paused boolean not null default false,
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  check ((cadence_months is not null) <> (cadence_days is not null))
);

create table public.leader_followup_contacts (
  id uuid primary key default gen_random_uuid(),
  followup_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete restrict,
  contacted_on date not null,
  outcome text not null check (outcome in ('connected', 'attempted')),
  method text not null check (method in ('phone', 'text', 'email', 'in_person', 'other')),
  notes text check (char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  foreign key (followup_id, owner_id) references public.leader_followups(id, owner_id) on delete restrict
);

alter table public.leader_followups enable row level security;
alter table public.leader_followup_contacts enable row level security;
revoke all on public.leader_followups, public.leader_followup_contacts from public, anon, authenticated;
grant select on public.leader_followups, public.leader_followup_contacts to authenticated;
-- A stable random draft ID makes a retried insert conflict instead of creating a duplicate.
-- The ID is insert-only; owners, versions and history summaries remain server-owned.
grant insert (id, display_name, leadership_role, team_name, cadence_months, cadence_days,
  first_due_on, snoozed_until, paused, notes) on public.leader_followups to authenticated;
grant update (display_name, leadership_role, team_name, cadence_months, cadence_days,
  first_due_on, snoozed_until, paused, notes) on public.leader_followups to authenticated;

create policy owners_read_leader_followups on public.leader_followups for select to authenticated
using (owner_id = (select auth.uid()) and (select private.current_staff_role()) in ('admin', 'editor'));
create policy owners_insert_leader_followups on public.leader_followups for insert to authenticated
with check (owner_id = (select auth.uid()) and (select private.current_staff_role()) in ('admin', 'editor'));
create policy owners_update_leader_followups on public.leader_followups for update to authenticated
using (owner_id = (select auth.uid()) and (select private.current_staff_role()) in ('admin', 'editor'))
with check (owner_id = (select auth.uid()) and (select private.current_staff_role()) in ('admin', 'editor'));
create policy owners_read_leader_contacts on public.leader_followup_contacts for select to authenticated
using (owner_id = (select auth.uid()) and (select private.current_staff_role()) in ('admin', 'editor'));

create function private.stamp_leader_followup()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.last_contact_on is not null then
      raise exception 'Record a contact to update the latest contact date' using errcode = '23514';
    end if;
    new.owner_id := auth.uid();
    new.version := 1;
    new.created_at := now();
  else
    if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id then
      raise exception 'Personal follow-up identity and owner cannot be changed' using errcode = '23514';
    end if;
    if new.last_contact_on is distinct from old.last_contact_on then
      raise exception 'Record a contact to update the latest contact date' using errcode = '23514';
    end if;
    new.created_at := old.created_at;
    new.version := old.version + 1;
    -- The RPC inserts the journal entry before updating its parent in one transaction.
    select max(c.contacted_on) into new.last_contact_on
      from public.leader_followup_contacts c where c.followup_id = old.id and c.owner_id = old.owner_id
        and c.outcome = 'connected';
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke all on function private.stamp_leader_followup() from public, anon, authenticated;
create trigger leader_followups_stamp before insert or update on public.leader_followups
for each row execute function private.stamp_leader_followup();
create trigger leader_followups_preserve_delete before delete on public.leader_followups
for each row execute function private.reject_preserved_record_change();
create trigger leader_followups_preserve_truncate before truncate on public.leader_followups
for each statement execute function private.reject_preserved_record_change();
create trigger leader_contacts_preserve before update or delete on public.leader_followup_contacts
for each row execute function private.reject_preserved_record_change();
create trigger leader_contacts_preserve_truncate before truncate on public.leader_followup_contacts
for each statement execute function private.reject_preserved_record_change();

-- Personal notes and even their row identifiers stay out of the shared office audit stream.
-- The append-only contact journal is the owner's record of contact activity.
create index leader_followups_owner_idx on public.leader_followups(owner_id, updated_at desc);
create index leader_contacts_owner_followup_date_idx on public.leader_followup_contacts(owner_id, followup_id, contacted_on desc);

create function private.record_leader_contact(
  p_id uuid, p_version integer, p_contacted_on date, p_outcome text, p_method text, p_notes text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row public.leader_followups%rowtype;
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_notes text := nullif(btrim(p_notes), '');
begin
  if auth.uid() is null or not coalesce(private.current_staff_role() in ('admin', 'editor'), false) then
    raise exception 'Only the authorized owner may record this contact' using errcode = '42501';
  end if;
  select * into v_row from public.leader_followups
    where id = p_id and owner_id = auth.uid() for update;
  if not found then
    raise exception 'Only the authorized owner may record this contact' using errcode = '42501';
  end if;
  if p_version is null or p_version <> v_row.version then
    raise exception 'This follow-up has changed. Reload before recording contact' using errcode = '40001';
  end if;
  if p_contacted_on is null or p_contacted_on > v_today
    or p_outcome is null or p_outcome not in ('connected', 'attempted')
    or p_method is null or p_method not in ('phone', 'text', 'email', 'in_person', 'other')
    or char_length(v_notes) > 2000 then
    raise exception 'Check the contact date, outcome, method and note length' using errcode = '22023';
  end if;
  insert into public.leader_followup_contacts(followup_id, owner_id, contacted_on, outcome, method, notes)
  values (v_row.id, auth.uid(), p_contacted_on, p_outcome, p_method, v_notes);
  update public.leader_followups set
    -- A fresh successful contact closes a snooze. Backdated history and attempts preserve it.
    snoozed_until = case when p_outcome = 'connected' and p_contacted_on = v_today
      and (v_row.last_contact_on is null or p_contacted_on >= v_row.last_contact_on)
      then null else snoozed_until end
  where id = v_row.id
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'version', v_row.version, 'last_contact_on', v_row.last_contact_on);
end $$;

create function public.record_leader_contact(
  p_id uuid, p_version integer, p_contacted_on date, p_outcome text, p_method text, p_notes text
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.record_leader_contact(p_id, p_version, p_contacted_on, p_outcome, p_method, p_notes)
$$;
revoke all on function private.record_leader_contact(uuid,integer,date,text,text,text),
  public.record_leader_contact(uuid,integer,date,text,text,text) from public, anon, authenticated;
grant execute on function private.record_leader_contact(uuid,integer,date,text,text,text),
  public.record_leader_contact(uuid,integer,date,text,text,text) to authenticated;

commit;
