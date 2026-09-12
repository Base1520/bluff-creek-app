// Offline planning only. No database access, timer, transport, or send permission.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dueFor, validDate } = require('../../admin/care.js');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const DAY = 86400000;
const KINDS = ['guest_task', 'care_plan'];
const STATES = ['open', 'completed', 'paused', 'removed', 'inactive'];
const ROLES = ['deacon', 'sunday_school', 'welcome', 'pastoral', 'custom'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
const list = (value, limit = 5000) => Array.isArray(value) && value.length <= limit;
const nullableId = value => value === null || (typeof value === 'string' && ID.test(value));
const requireValue = value => { if (!value) throw Error('REMINDER_INPUT_INVALID'); };
const midnight = day => Date.parse(day + 'T12:00:00Z');

function churchClock(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/Chicago', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', hourCycle:'h23'
  }).formatToParts(now).map(({type,value}) => [type,value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,hour:Number(parts.hour)};
}

// These bindings/cycle IDs do not yet exist in the live schema. Only a future
// authenticated server adapter may produce them; browser fields are not proof.
function checkBinding(binding, type, id) {
  requireValue(binding && binding.source_type === type && binding.source_id === id &&
    binding.approved === true && typeof binding.enabled === 'boolean' &&
    ID.test(binding.cycle_id) && nullableId(binding.user_id) && positive(binding.version));
}

export function careSource({plan, visits, person, binding, linkedGuestTask = null}, today) {
  requireValue(validDate(today) && plan && ID.test(plan.id) && ID.test(plan.contact_id) &&
    person && person.id === plan.contact_id && ['active','visitor','inactive'].includes(person.status) &&
    ROLES.includes(plan.care_role) && typeof plan.paused === 'boolean' && typeof plan.one_time === 'boolean' &&
    validDate(plan.started_on) && (plan.first_due_on === null || validDate(plan.first_due_on)) &&
    positive(plan.version) && list(visits));
  requireValue((Number.isInteger(plan.cadence_months) && plan.cadence_months >= 1 && plan.cadence_months <= 12) ||
    (plan.cadence_months === null && Number.isInteger(plan.cadence_days) && plan.cadence_days >= 1 && plan.cadence_days <= 365));
  checkBinding(binding, 'care_plan', plan.id);
  requireValue(visits.every(v => v && ID.test(v.id) && ID.test(v.contact_id) && ROLES.includes(v.care_role)));
  const relevant = visits.filter(v => v.contact_id === plan.contact_id && v.care_role === plan.care_role);
  const visitIds = new Set();
  for (const v of relevant) {
    requireValue(ID.test(v.id) && !visitIds.has(v.id) && validDate(v.contacted_on) &&
      ['contacted','attempted'].includes(v.outcome) &&
      (v.next_contact_on === null || validDate(v.next_contact_on)) &&
      typeof v.created_at === 'string' && Number.isFinite(Date.parse(v.created_at)));
    visitIds.add(v.id);
  }
  // A linked initial welcome plan is represented by its Intake action, even
  // after that task completes/removes. Independent ongoing plans are retained.
  if (linkedGuestTask !== null) {
    requireValue(ID.test(linkedGuestTask.id) && linkedGuestTask.kind === 'guest_followup' &&
      linkedGuestTask.contact_id === plan.contact_id);
    if (plan.one_time && plan.care_role === 'welcome') return null;
  }
  const due = dueFor(plan, relevant, today);
  const state = !binding.enabled || person.status === 'inactive' ? 'inactive' :
    due.paused ? 'paused' : due.completed ? 'completed' : 'open';
  const source = {type:'care_plan', id:plan.id, cycle_id:binding.cycle_id,
    due_on:due.due, state, owner_user_id:binding.user_id};
  // New contacts can change the schedule without modifying assignment.version.
  // Hash only scheduling fields; names, emails and private notes are excluded.
  source.revision = hash([source, binding.version, plan.version, plan.care_role,
    plan.started_on, plan.first_due_on, plan.cadence_days, plan.cadence_months,
    relevant.map(v => [v.id,v.contacted_on,v.outcome,v.next_contact_on,v.created_at])
      .sort((a,b) => a[0].localeCompare(b[0]))]);
  return source;
}

export function guestSource({task, registration, binding}) {
  requireValue(task && ID.test(task.id) && task.kind === 'guest_followup' &&
    ['new','in_progress','completed'].includes(task.status) && validDate(task.due_on) &&
    positive(task.version) && registration && ID.test(registration.id) &&
    task.registration_id === registration.id && ['pending','reviewed','archived'].includes(registration.status) &&
    positive(registration.guest_lifecycle_version) &&
    (task.guest_removed_at === null || Number.isFinite(Date.parse(task.guest_removed_at))) &&
    (registration.guest_removed_at === null || Number.isFinite(Date.parse(registration.guest_removed_at))));
  checkBinding(binding, 'guest_task', task.id);
  const removed = task.guest_removed_at !== null || registration.guest_removed_at !== null || registration.status === 'archived';
  // Explicit lifecycle consent is separate from the record's current visibility.
  // Restoring a record must not silently re-enable a previous notification cycle.
  requireValue(positive(binding.lifecycle_version));
  const state = removed ? 'removed' : !binding.enabled || binding.lifecycle_version !== registration.guest_lifecycle_version ?
    'inactive' : task.status === 'completed' ? 'completed' : 'open';
  const source = {type:'guest_task',id:task.id,cycle_id:binding.cycle_id,
    due_on:task.due_on,state,owner_user_id:binding.user_id};
  source.revision = hash([source,task.version,binding.version,registration.guest_lifecycle_version]);
  return source;
}

function validateSnapshot(snapshot, now) {
  requireValue(snapshot && snapshot.version === 1 && snapshot.complete === true &&
    typeof snapshot.generated_at === 'string' && Number.isFinite(Date.parse(snapshot.generated_at)) &&
    now.getTime() - Date.parse(snapshot.generated_at) <= 300000 &&
    Date.parse(snapshot.generated_at) - now.getTime() <= 30000 &&
    list(snapshot.sources) && list(snapshot.recipients, 500) && list(snapshot.pastor_user_ids, 20) &&
    list(snapshot.receipts, 20000) && list(snapshot.holds, 1000));
  const sourceIds = new Set(), recipientIds = new Set(), receiptIds = new Set();
  for (const s of snapshot.sources) {
    requireValue(s && KINDS.includes(s.type) && ID.test(s.id) && ID.test(s.cycle_id) &&
      HASH.test(s.revision) && STATES.includes(s.state) && nullableId(s.owner_user_id) &&
      (s.due_on === null || validDate(s.due_on)) && !sourceIds.has(s.type + ':' + s.id));
    sourceIds.add(s.type + ':' + s.id);
  }
  for (const r of snapshot.recipients) {
    requireValue(r && ID.test(r.user_id) && !recipientIds.has(r.user_id) &&
      typeof r.eligible === 'boolean' && ['admin','editor','viewer'].includes(r.role) && list(r.destinations, 10));
    recipientIds.add(r.user_id);
    const destinations = new Set();
    for (const d of r.destinations) {
      // Email destination keys are opaque registry hashes, never raw addresses.
      // Push delivery/permission belongs to a later package and is not accepted.
      requireValue(d && d.channel === 'email' && HASH.test(d.key) && typeof d.enabled === 'boolean' && !destinations.has(d.key));
      destinations.add(d.key);
    }
  }
  requireValue(new Set(snapshot.pastor_user_ids).size === snapshot.pastor_user_ids.length && snapshot.pastor_user_ids.every(id => ID.test(id)));
  for (const r of snapshot.receipts) {
    requireValue(r && HASH.test(r.key) && !receiptIds.has(r.key) && r.channel === 'email' && HASH.test(r.destination_key) &&
      ['queued','sending','accepted','failed','uncertain','cancelled'].includes(r.status));
    receiptIds.add(r.key);
  }
  for (const h of snapshot.holds) requireValue(h && h.channel === 'email' && HASH.test(h.destination_key) &&
    ['delivery_uncertain','delivery_failed','recipient_paused'].includes(h.reason));
}

export function planReminders(snapshot, nowValue) {
  let now;
  try {
    now = new Date(nowValue);
    requireValue(typeof nowValue === 'string' && Number.isFinite(now.getTime()));
    validateSnapshot(snapshot, now);
  } catch {
    return {version:1,dry_run:true,status:'blocked',code:'REMINDER_SNAPSHOT_UNAVAILABLE',candidates:[],counts:null};
  }
  const clock = churchClock(now), seen = new Set(snapshot.receipts.map(r => r.key));
  const holds = new Set(snapshot.holds.map(h => h.channel + ':' + h.destination_key));
  const attentionHolds = new Set(holds);
  // A new calendar day cannot bypass an unresolved ambiguous or failed send.
  // Pending work also blocks a newer digest until the durable queue resolves it.
  for (const r of snapshot.receipts) {
    if (['queued','sending','failed','uncertain'].includes(r.status)) holds.add(r.channel + ':' + r.destination_key);
    if (['failed','uncertain'].includes(r.status)) attentionHolds.add(r.channel + ':' + r.destination_key);
  }
  const recipients = new Map(snapshot.recipients.map(r => [r.user_id,r]));
  const available = id => {
    const r = recipients.get(id);
    return r && r.eligible && ['admin','editor'].includes(r.role) ?
      r.destinations.filter(d => d.enabled) : [];
  };
  const counts = {open:0,due:0,overdue:0,unassigned:0,recipient_unavailable:0,unscheduled:0,delivery_attention:0,
    pastor_unavailable:snapshot.pastor_user_ids.length === 0 ? 1 : snapshot.pastor_user_ids.filter(id => !available(id).length).length,
    held_destinations:0};
  const groups = new Map();
  function add(source, userId, role, reasons, daysOverdue) {
    for (const dest of available(userId)) {
      const groupKey = dest.channel + ':' + dest.key;
      if (!groups.has(groupKey)) groups.set(groupKey,{channel:dest.channel,destination_key:dest.key,
        users:new Set(),sources:new Map(),occurrences:new Set()});
      const g = groups.get(groupKey);g.users.add(userId);
      const sourceKey = source.type + ':' + source.id;
      if (!g.sources.has(sourceKey)) g.sources.set(sourceKey,{type:source.type,id:source.id,
        cycle_id:source.cycle_id,revision:source.revision,due_on:source.due_on,reasons:new Set(),roles:new Set()});
      const row = g.sources.get(sourceKey);row.roles.add(role);reasons.forEach(reason => row.reasons.add(reason));
      const daily = hash(['creek-care-v1','daily',clock.date,groupKey]);
      if (!seen.has(daily)) g.occurrences.add(daily);
      if (daysOverdue >= 3) {
        const escalation = hash(['creek-care-v1','escalation',source.type,source.id,source.cycle_id,source.due_on,groupKey]);
        if (!seen.has(escalation)) {g.occurrences.add(escalation);row.reasons.add('three_days_overdue');}
      }
    }
  }
  for (const source of snapshot.sources) {
    if (source.state !== 'open') continue;
    counts.open++;
    const due = source.due_on !== null && source.due_on <= clock.date;
    const daysOverdue = due ? Math.max(0,Math.round((midnight(clock.date)-midnight(source.due_on))/DAY)) : 0;
    const unassigned = source.owner_user_id === null;
    const unavailable = !unassigned && available(source.owner_user_id).length === 0;
    const deliveryAttention = due && !unassigned && available(source.owner_user_id).some(d => attentionHolds.has(d.channel+':'+d.key));
    const unscheduled = source.due_on === null;
    if (due) counts.due++;if (daysOverdue) counts.overdue++;
    if (unassigned) counts.unassigned++;if (unavailable) counts.recipient_unavailable++;if (unscheduled) counts.unscheduled++;
    if (deliveryAttention) counts.delivery_attention++;
    if (due && !unassigned && !unavailable) add(source,source.owner_user_id,'assigned',[daysOverdue ? 'overdue' : 'due_today'],daysOverdue);
    if (daysOverdue || unassigned || unavailable || unscheduled || deliveryAttention) {
      const reasons = [daysOverdue && 'overdue',unassigned && 'unassigned',unavailable && 'recipient_unavailable',unscheduled && 'unscheduled',deliveryAttention && 'delivery_needs_attention'].filter(Boolean);
      for (const id of snapshot.pastor_user_ids) add(source,id,'pastor',reasons,daysOverdue);
    }
  }
  // No historical catch-up digest is emitted. Evaluate today's complete snapshot
  // only, within business hours; retries/leases are not simulated by this tool.
  if (clock.hour < 9 || clock.hour >= 17) return {version:1,dry_run:true,status:'waiting',date:clock.date,candidates:[],counts};
  const candidates = [];
  for (const [key,g] of groups) {
    if (holds.has(key)) {counts.held_destinations++;continue;}
    if (!g.occurrences.size) continue;
    const sourceRefs = [...g.sources.values()].map(s => ({...s,reasons:[...s.reasons].sort(),roles:[...s.roles].sort()}))
      .sort((a,b) => (a.type+':'+a.id).localeCompare(b.type+':'+b.id));
    const occurrenceKeys = [...g.occurrences].sort(), userIds = [...g.users].sort();
    const c = {channel:g.channel,destination_key:g.destination_key,recipient_user_ids:userIds,
      occurrence_keys:occurrenceKeys,source_refs:sourceRefs,
      payload:{title:'Creek Office',body:'Your care follow-ups need attention. Sign in to review.',path:'/admin/#care'}};
    c.plan_key = hash(['creek-care-plan-v1',clock.date,g.channel,g.destination_key,occurrenceKeys]);
    c.review_fingerprint = hash([c.plan_key,userIds,sourceRefs]);
    candidates.push(c);
  }
  candidates.sort((a,b) => a.plan_key.localeCompare(b.plan_key));
  return {version:1,dry_run:true,status:'planned',date:clock.date,candidates,counts};
}

// A match is review evidence only. A future dispatcher must perform an atomic
// claim and permission/source recheck; this pure function cannot prevent a race.
export function compareFreshPlan(candidate, snapshot, nowValue) {
  const fresh = planReminders(snapshot, nowValue);
  const match = fresh.status === 'planned' && candidate && fresh.candidates.find(c =>
    c.plan_key === candidate.plan_key && c.review_fingerprint === candidate.review_fingerprint &&
    JSON.stringify(c) === JSON.stringify(candidate));
  return {dry_run:true,matches:!!match,reason:match ? 'same_plan' : 'changed_or_unavailable'};
}
