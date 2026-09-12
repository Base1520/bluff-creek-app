import test from 'node:test';
import assert from 'node:assert/strict';
import { careSource, guestSource, planReminders, compareFreshPlan } from './planner.mjs';

const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = n => String(n).repeat(64);
const ids = { pastor:uuid(1), deacon:uuid(2), source:uuid(3), cycle:uuid(4), person:uuid(5), registration:uuid(6), other:uuid(7) };
const NOW = '2026-09-12T14:00:00Z';
const clone = value => structuredClone(value);
const recipient = (user_id, key) => ({user_id,eligible:true,role:'editor',destinations:[{channel:'email',key,enabled:true}]});
const source = (overrides={}) => ({type:'care_plan',id:ids.source,cycle_id:ids.cycle,revision:digest(3),due_on:'2026-09-11',state:'open',owner_user_id:ids.deacon,...overrides});
function snapshot(now=NOW) {
  return {version:1,complete:true,generated_at:now,sources:[source()],
    recipients:[recipient(ids.pastor,digest(1)),recipient(ids.deacon,digest(2))],
    pastor_user_ids:[ids.pastor],receipts:[],holds:[]};
}
function binding(type='care_plan') {
  return {source_type:type,source_id:ids.source,approved:true,enabled:true,
    cycle_id:ids.cycle,user_id:ids.deacon,version:1,lifecycle_version:1};
}
function careFixture() {
  return {plan:{id:ids.source,contact_id:ids.person,care_role:'deacon',paused:false,one_time:false,
    started_on:'2026-06-01',first_due_on:null,cadence_days:28,cadence_months:3,version:1},
    visits:[],person:{id:ids.person,status:'active'},binding:binding()};
}
function guestFixture() {
  return {task:{id:ids.source,kind:'guest_followup',registration_id:ids.registration,status:'new',
    due_on:'2026-09-09',version:1,guest_removed_at:null},
    registration:{id:ids.registration,status:'pending',guest_lifecycle_version:1,guest_removed_at:null},
    binding:binding('guest_task')};
}
function visit(n, day, outcome='contacted', next=null) {
  return {id:uuid(100+n),contact_id:ids.person,care_role:'deacon',contacted_on:day,
    outcome,next_contact_on:next,created_at:`${day}T16:00:00Z`};
}
function receiptsFor(candidates, status='accepted') {
  return candidates.flatMap(candidate => candidate.occurrence_keys.map(key => ({key,status,
    channel:candidate.channel,destination_key:candidate.destination_key})));
}
function assertBlocked(value, now=NOW) {
  const result = planReminders(value,now);
  assert.equal(result.status,'blocked');
  assert.deepEqual(result.candidates,[]);
  assert.equal(result.counts,null);
  assert.equal(result.dry_run,true);
  return result;
}

test('unresolved queued or sending work prevents a new daily digest across midnight without claiming delivery failure', () => {
  for (const status of ['queued','sending']) {
    const input=snapshot(); input.sources[0].due_on='2026-09-12';
    input.receipts=receiptsFor(planReminders(input,NOW).candidates,status);
    const tomorrow='2026-09-13T14:00:00Z'; input.generated_at=tomorrow;
    const result=planReminders(input,tomorrow);
    assert.ok(!result.candidates.some(c=>c.destination_key===digest(2)));
    assert.equal(result.counts.delivery_attention,0);
    assert.equal(result.counts.held_destinations,1);
    input.receipts.forEach(r=>{r.status='accepted';});
    assert.ok(planReminders(input,tomorrow).candidates.some(c=>c.destination_key===digest(2)));
  }
});

test('9 a.m. start and 5 p.m. cutoff follow Central through both daylight-saving transitions', () => {
  for (const [before,start,last,cutoff,day] of [
    ['2026-03-07T14:59:59Z','2026-03-07T15:00:00Z','2026-03-07T22:59:59Z','2026-03-07T23:00:00Z','2026-03-07'],
    ['2026-03-08T13:59:59Z','2026-03-08T14:00:00Z','2026-03-08T21:59:59Z','2026-03-08T22:00:00Z','2026-03-08'],
    ['2026-10-31T13:59:59Z','2026-10-31T14:00:00Z','2026-10-31T21:59:59Z','2026-10-31T22:00:00Z','2026-10-31'],
    ['2026-11-01T14:59:59Z','2026-11-01T15:00:00Z','2026-11-01T22:59:59Z','2026-11-01T23:00:00Z','2026-11-01'],
  ]) {
    for (const [now,expected] of [[before,'waiting'],[start,'planned'],[last,'planned'],[cutoff,'waiting']]) {
      const input=snapshot(now); input.sources[0].due_on=day;
      const result=planReminders(input,now);
      assert.equal(result.status,expected,now);
      assert.equal(result.date,day);
      assert.equal(result.candidates.length,expected==='planned'?1:0);
    }
  }
});

test('due today reaches its owner; one day overdue also reaches the pastor; three days adds one escalation occurrence', () => {
  for (const [due,numberOfRecipients,occurrences,escalates] of [
    ['2026-09-13',0,0,false],['2026-09-12',1,1,false],
    ['2026-09-11',2,1,false],['2026-09-10',2,1,false],['2026-09-09',2,2,true],
  ]) {
    const input=snapshot(); input.sources[0].due_on=due;
    const result=planReminders(input,NOW);
    assert.equal(result.candidates.length,numberOfRecipients,due);
    for (const candidate of result.candidates) {
      assert.equal(candidate.occurrence_keys.length,occurrences,due);
      assert.equal(candidate.source_refs[0].reasons.includes('three_days_overdue'),escalates,due);
    }
  }
  for (const [now,due] of [['2026-03-09T14:00:00Z','2026-03-06'],['2026-11-02T15:00:00Z','2026-10-30']]) {
    const input=snapshot(now); input.sources[0].due_on=due;
    assert.ok(planReminders(input,now).candidates.every(c=>c.source_refs[0].reasons.includes('three_days_overdue')));
  }
});

test('repeated planning is deterministic and does not mutate input; ordering does not change a digest', () => {
  const input=snapshot();
  input.sources.push(source({id:ids.other,revision:digest(4),due_on:'2026-09-09'}));
  input.recipients[0].destinations.push({channel:'email',key:digest(5),enabled:true});
  const saved=clone(input), first=planReminders(input,NOW);
  assert.deepEqual(input,saved);
  assert.deepEqual(planReminders(input,NOW),first);
  input.sources.reverse(); input.recipients.reverse(); input.recipients.forEach(r=>r.destinations.reverse());
  assert.deepEqual(planReminders(input,NOW),first);
});

test('shared pastor and owner destination receives one digest and one source with both roles', () => {
  const input=snapshot(); input.recipients[1].destinations[0].key=digest(1);
  const result=planReminders(input,NOW);
  assert.equal(result.candidates.length,1);
  const candidate=result.candidates[0];
  assert.deepEqual(candidate.recipient_user_ids,[ids.pastor,ids.deacon]);
  assert.equal(candidate.occurrence_keys.length,1);
  assert.equal(candidate.source_refs.length,1);
  assert.deepEqual(candidate.source_refs[0].roles,['assigned','pastor']);
  input.pastor_user_ids=[ids.deacon];
  const sameUser=planReminders(input,NOW).candidates[0];
  assert.deepEqual(sameUser.recipient_user_ids,[ids.deacon]);
  assert.equal(sameUser.source_refs.length,1);
});

test('receipts prevent repeated same-day digest even after a source revision changes; next day permits a new daily digest', () => {
  const input=snapshot(), initial=planReminders(input,NOW);
  input.receipts=receiptsFor(initial.candidates);
  input.sources[0].revision=digest(6);
  assert.equal(planReminders(input,NOW).candidates.length,0);
  const tomorrow='2026-09-13T14:00:00Z'; input.generated_at=tomorrow;
  const next=planReminders(input,tomorrow);
  assert.equal(next.candidates.length,2);
  assert.ok(next.candidates.every(c=>c.occurrence_keys.length===1));
});

test('a sent escalation is not regenerated next day for the same due occurrence', () => {
  const input=snapshot(); input.sources[0].due_on='2026-09-09';
  const initial=planReminders(input,NOW); input.receipts=receiptsFor(initial.candidates);
  const tomorrow='2026-09-13T14:00:00Z'; input.generated_at=tomorrow;
  const next=planReminders(input,tomorrow);
  assert.equal(next.candidates.length,2);
  for (const candidate of next.candidates) {
    assert.equal(candidate.occurrence_keys.length,1);
    assert.ok(!candidate.source_refs[0].reasons.includes('three_days_overdue'));
    assert.ok(!input.receipts.some(r=>r.key===candidate.occurrence_keys[0]));
  }
});

test('completed, removed, paused and inactive sources cannot generate a reminder or an open count', () => {
  const input=snapshot();
  input.sources=['completed','removed','paused','inactive'].map((state,i)=>source({id:uuid(20+i),state,owner_user_id:null}));
  const result=planReminders(input,NOW);
  assert.deepEqual(result.candidates,[]);
  for (const name of ['open','due','overdue','unassigned','recipient_unavailable','unscheduled']) assert.equal(result.counts[name],0,name);
});

test('missing, failed, incomplete, stale, future, malformed and oversized snapshots fail closed', () => {
  assertBlocked(null); assertBlocked(undefined); assertBlocked({error:'PRIVATE_FIXTURE_ERROR'});
  for (const mutate of [
    s=>{s.complete=false;},s=>{delete s.sources;},s=>{s.sources=null;},s=>{delete s.receipts;},s=>{delete s.holds;},
    s=>{s.generated_at='2026-09-12T13:54:59Z';},s=>{s.generated_at='2026-09-12T14:00:31Z';},
    s=>{s.sources[0].due_on='2026-02-30';},s=>{s.sources.push(clone(s.sources[0]));},
    s=>{s.sources=Array.from({length:5001},(_,i)=>source({id:uuid(1000+i)}));},
    s=>{s.recipients.push(clone(s.recipients[0]));},s=>{s.pastor_user_ids.push(ids.pastor);},
    s=>{s.receipts=[{key:digest(8),status:'accepted'}];},
    s=>{s.receipts=[{key:digest(8),status:'accepted',channel:'push',destination_key:digest(1)}];},
    s=>{s.receipts=[{key:digest(8),status:'accepted',channel:'email',destination_key:'fixture@example.invalid'}];},
    s=>{s.recipients[0].destinations[0].channel='push';},
    s=>{s.recipients[0].destinations[0].key='fixture@example.invalid';},
  ]) {const input=snapshot();mutate(input);assertBlocked(input);}
  assertBlocked(snapshot(),'not-a-date'); assertBlocked(snapshot(),new Date(NOW));
  const edge=snapshot();edge.generated_at='2026-09-12T13:55:00Z';assert.equal(planReminders(edge,NOW).status,'planned');
  edge.generated_at='2026-09-12T14:00:30Z';assert.equal(planReminders(edge,NOW).status,'planned');
});

test('only explicitly configured eligible staff recipients are used and display labels grant no access', () => {
  const input=snapshot();
  input.recipients.push(recipient(ids.other,digest(7)));
  input.sources[0].assigned_to='PRIVATE_FIXTURE_PASTOR_NAME';
  input.sources[0].owner_user_id=null;
  const result=planReminders(input,NOW);
  assert.deepEqual(result.candidates.flatMap(c=>c.recipient_user_ids),[ids.pastor]);
  assert.equal(result.counts.unassigned,1);
  input.pastor_user_ids=[];
  const noPastor=planReminders(input,NOW);
  assert.equal(noPastor.counts.pastor_unavailable,1);
  assert.deepEqual(noPastor.candidates,[]);
});

test('missing or deactivated owner becomes a pastor setup issue without sending to that owner', () => {
  for (const mutate of [
    s=>{s.recipients=s.recipients.filter(r=>r.user_id!==ids.deacon);},
    s=>{s.recipients[1].eligible=false;},s=>{s.recipients[1].role='viewer';},
    s=>{s.recipients[1].destinations[0].enabled=false;},s=>{s.recipients[1].destinations=[];},
  ]) {
    const input=snapshot(); mutate(input);
    const result=planReminders(input,NOW);
    assert.equal(result.counts.recipient_unavailable,1);
    assert.equal(result.candidates.length,1);
    assert.deepEqual(result.candidates[0].recipient_user_ids,[ids.pastor]);
    assert.ok(result.candidates[0].source_refs[0].reasons.includes('recipient_unavailable'));
  }
  const input=snapshot();input.recipients[0].eligible=false;
  const noPastor=planReminders(input,NOW);
  assert.equal(noPastor.counts.pastor_unavailable,1);
  assert.deepEqual(noPastor.candidates.flatMap(c=>c.recipient_user_ids),[ids.deacon]);
});

test('unscheduled sources produce only a pastor setup reminder', () => {
  const input=snapshot();input.sources[0].due_on=null;
  const result=planReminders(input,NOW);
  assert.equal(result.counts.unscheduled,1);assert.equal(result.counts.due,0);
  assert.equal(result.candidates.length,1);
  assert.deepEqual(result.candidates[0].recipient_user_ids,[ids.pastor]);
  assert.deepEqual(result.candidates[0].source_refs[0].reasons,['unscheduled']);
});

test('care scheduling preserves retry dates, ignores future and unrelated contacts, and fingerprints newly recorded attempts', () => {
  const fixture=careFixture();
  fixture.visits=[visit(1,'2026-09-01','contacted','2026-09-10'),visit(2,'2026-09-08','attempted')];
  const initial=careSource(fixture,'2026-09-12');
  assert.equal(initial.due_on,'2026-09-10');
  fixture.visits.push(visit(3,'2026-09-09','attempted'));
  const newAttempt=careSource(fixture,'2026-09-12');
  assert.equal(newAttempt.due_on,'2026-09-10');
  assert.notEqual(newAttempt.revision,initial.revision,'new visits do not update the plan row version');
  fixture.visits.push({...visit(4,'2026-09-10'),care_role:'pastoral'},
    {...visit(5,'2026-09-10'),contact_id:ids.other},visit(6,'2026-09-13'));
  assert.equal(careSource(fixture,'2026-09-12').due_on,'2026-09-10');
  const originalOrder=careSource(fixture,'2026-09-12');fixture.visits.reverse();
  assert.deepEqual(careSource(fixture,'2026-09-12'),originalOrder);
  fixture.visits.push(visit(7,'2026-09-12'));
  assert.equal(careSource(fixture,'2026-09-12').due_on,'2026-12-12');
});

test('care calendar-month clamp and restarted one-time plans agree with Office scheduling', () => {
  const monthly=careFixture();monthly.plan.started_on='2026-01-31';monthly.plan.cadence_months=1;
  assert.equal(careSource(monthly,'2026-02-28').due_on,'2026-02-28');
  const fixture=careFixture();Object.assign(fixture.plan,{care_role:'welcome',one_time:true,started_on:'2026-09-04',first_due_on:'2026-09-05'});
  fixture.visits=[{...visit(1,'2026-09-03'),care_role:'welcome'}];
  assert.equal(careSource(fixture,'2026-09-12').state,'open');
  fixture.visits.push({...visit(2,'2026-09-06','attempted'),care_role:'welcome'});
  assert.equal(careSource(fixture,'2026-09-12').due_on,'2026-09-05');
  fixture.visits.push({...visit(3,'2026-09-07'),care_role:'welcome'});
  const complete=careSource(fixture,'2026-09-12');
  assert.equal(complete.state,'completed');assert.equal(complete.due_on,null);
  fixture.linkedGuestTask={id:ids.other,kind:'guest_followup',contact_id:ids.person};
  assert.equal(careSource(fixture,'2026-09-12'),null,'linked initial welcome is represented by its intake source');
  fixture.linkedGuestTask.contact_id=ids.other;
  assert.throws(()=>careSource(fixture,'2026-09-12'),/REMINDER_INPUT_INVALID/,'a different person is not a valid duplicate link');
  fixture.linkedGuestTask.contact_id=ids.person;
  fixture.plan.one_time=false;
  assert.notEqual(careSource(fixture,'2026-09-12'),null,'independent recurring care is retained alongside an intake task');
});

test('care bindings and source fields reject unsupported states/outcomes and paused or inactive people are suppressed', () => {
  for (const [mutate,state] of [
    [f=>{f.plan.paused=true;},'paused'],[f=>{f.person.status='inactive';},'inactive'],
    [f=>{f.binding.enabled=false;},'inactive'],[f=>{f.person.status='visitor';},'open'],
  ]) {const f=careFixture();mutate(f);assert.equal(careSource(f,'2026-09-12').state,state);}
  for (const mutate of [
    f=>{f.binding.approved=false;},f=>{f.binding.source_id=ids.other;},
    f=>{f.binding.user_id='PRIVATE_FIXTURE_LABEL';},f=>{f.person.status='deceased';},
    f=>{f.visits=[visit(1,'2026-09-01','rescheduled')];},
    f=>{f.visits=[visit(1,'2026-09-01'),visit(1,'2026-09-01')];},
  ]) {const f=careFixture();mutate(f);assert.throws(()=>careSource(f,'2026-09-12'),/REMINDER_INPUT_INVALID/);}
});

test('guest removal and archive suppress reminders; restoration requires an updated lifecycle binding', () => {
  for (const mutate of [f=>{f.task.guest_removed_at=NOW;},f=>{f.registration.guest_removed_at=NOW;},f=>{f.registration.status='archived';}]) {
    const f=guestFixture();mutate(f);assert.equal(guestSource(f).state,'removed');
  }
  const f=guestFixture(), before=guestSource(f);
  f.task.status='completed';assert.equal(guestSource(f).state,'completed');
  f.task.status='new';f.registration.guest_lifecycle_version=3;
  assert.equal(guestSource(f).state,'inactive');
  f.binding.lifecycle_version=3;f.binding.version++;
  const restored=guestSource(f);assert.equal(restored.state,'open');assert.notEqual(restored.revision,before.revision);
  f.binding.enabled=false;assert.equal(guestSource(f).state,'inactive');
  f.binding.approved=false;assert.throws(()=>guestSource(f),/REMINDER_INPUT_INVALID/);
});

test('private content is excluded from source fingerprints, payloads and errors', () => {
  const f=careFixture(), clean=careSource(f,'2026-09-12');
  f.person.display_name='PRIVATE_FIXTURE_PERSON';f.person.email='private-fixture@example.invalid';
  f.plan.notes='PRIVATE_FIXTURE_CARE_NOTE';f.plan.assigned_to='PRIVATE_FIXTURE_STAFF_NAME';
  assert.deepEqual(careSource(f,'2026-09-12'),clean);
  const guest=guestFixture(), cleanGuest=guestSource(guest);
  guest.registration.first_name='PRIVATE_FIXTURE_GUEST';guest.registration.email='private-fixture@example.invalid';
  guest.task.request_text='PRIVATE_FIXTURE_PRAYER';
  assert.deepEqual(guestSource(guest),cleanGuest);
  const input=snapshot();input.sources=[clean, {...cleanGuest,id:ids.other}];
  input.private_error='PRIVATE_FIXTURE_ERROR';input.recipients[0].email='private-fixture@example.invalid';
  const result=planReminders(input,NOW);
  assert.equal(result.candidates.length,2);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_FIXTURE|private-fixture@example/);
  for (const c of result.candidates) {
    assert.deepEqual(c.payload,{title:'Creek Office',body:'Your care follow-ups need attention. Sign in to review.',path:'/admin/#care'});
    assert.doesNotMatch(JSON.stringify(c.payload),/10000000-/);
  }
  input.complete=false;
  assert.doesNotMatch(JSON.stringify(assertBlocked(input)),/PRIVATE_FIXTURE|private-fixture@example/);
});

test('fresh comparison rejects new sources, scheduling revisions, assignment changes and changed recipient eligibility/destination', () => {
  const input=snapshot();input.recipients[1].destinations[0].key=digest(1);
  const candidate=planReminders(input,NOW).candidates[0];
  assert.deepEqual(compareFreshPlan(candidate,input,NOW),{dry_run:true,matches:true,reason:'same_plan'});
  for (const mutate of [
    s=>{s.sources.push(source({id:ids.other,revision:digest(8)}));},
    s=>{s.sources[0].revision=digest(8);},s=>{s.sources[0].owner_user_id=null;},
    s=>{s.sources[0].due_on='2026-09-10';},s=>{s.sources[0].state='completed';},
    s=>{s.sources[0].cycle_id=ids.other;},s=>{s.recipients[1].eligible=false;},
    s=>{s.recipients[1].destinations[0].key=digest(8);},s=>{s.complete=false;},
    s=>{s.generated_at='2026-09-12T13:54:00Z';},
  ]) {const changed=clone(input);mutate(changed);assert.equal(compareFreshPlan(candidate,changed,NOW).matches,false);}
  const f=careFixture();f.plan.first_due_on='2026-09-10';
  input.sources=[careSource(f,'2026-09-12')];
  const before=planReminders(input,NOW).candidates[0];
  f.visits.push(visit(1,'2026-09-11','attempted'));
  input.sources=[careSource(f,'2026-09-12')];
  assert.equal(compareFreshPlan(before,input,NOW).matches,false,'new attempt invalidates review without resetting the due date');
});

test('fresh comparison rejects tampered fields even when review hashes are copied from a valid candidate', () => {
  const input=snapshot(), candidate=planReminders(input,NOW).candidates[0];
  for (const mutate of [
    c=>{c.payload.body='PRIVATE_FIXTURE_INJECTED_TEXT';},c=>{c.payload.path='https://example.invalid/';},
    c=>{c.destination_key=digest(8);},c=>{c.channel='push';},c=>{c.recipient_user_ids=[ids.other];},
    c=>{c.source_refs[0].revision=digest(8);},c=>{c.source_refs[0].reasons=[];},
    c=>{c.occurrence_keys=[digest(8)];},c=>{c.extra='unexpected';},
  ]) {const changed=clone(candidate);mutate(changed);assert.equal(compareFreshPlan(changed,input,NOW).matches,false);}
});

test('explicit destination holds survive the next day and source-cycle changes without blocking other destinations', () => {
  const input=snapshot();input.holds=[{channel:'email',destination_key:digest(2),reason:'delivery_uncertain'}];
  for (const now of [NOW,'2026-09-13T14:00:00Z']) {
    input.generated_at=now;input.sources[0].cycle_id=ids.other;input.sources[0].revision=digest(8);
    const result=planReminders(input,now);
    assert.equal(result.counts.held_destinations,1);
    assert.deepEqual(result.candidates.flatMap(c=>c.recipient_user_ids),[ids.pastor]);
  }
});

test('a held owner delivery due today produces a pastor delivery-attention reminder', () => {
  const input=snapshot();input.sources[0].due_on='2026-09-12';
  input.holds=[{channel:'email',destination_key:digest(2),reason:'delivery_failed'}];
  const result=planReminders(input,NOW);
  assert.equal(result.counts.delivery_attention,1);
  assert.equal(result.counts.held_destinations,1);
  assert.equal(result.candidates.length,1);
  assert.deepEqual(result.candidates[0].recipient_user_ids,[ids.pastor]);
  assert.ok(result.candidates[0].source_refs[0].reasons.includes('delivery_needs_attention'));
});

test('failed or uncertain receipts carry destination suppression into the next day until explicitly resolved', () => {
  for (const status of ['failed','uncertain']) {
    const input=snapshot(), first=planReminders(input,NOW);
    const owner=first.candidates.find(c=>c.recipient_user_ids.includes(ids.deacon));
    input.receipts=receiptsFor([owner],status);
    input.sources[0].revision=digest(8);input.sources[0].cycle_id=ids.other;
    const tomorrow='2026-09-13T14:00:00Z';input.generated_at=tomorrow;
    const held=planReminders(input,tomorrow);
    assert.equal(held.counts.held_destinations,1,status);
    assert.deepEqual(held.candidates.flatMap(c=>c.recipient_user_ids),[ids.pastor],status);
    input.receipts.forEach(r=>{r.status='cancelled';});
    assert.equal(planReminders(input,tomorrow).candidates.length,2,'explicitly resolved receipt permits new-day planning');
  }
});
