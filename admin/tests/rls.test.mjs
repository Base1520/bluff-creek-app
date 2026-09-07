import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Synthetic IDs only. These schemas model the Supabase dependencies; the
// checked-in application schema itself is executed unchanged in PostgreSQL.
const ids = { admin:'00000000-0000-4000-8000-000000000001', editor:'00000000-0000-4000-8000-000000000002', viewer:'00000000-0000-4000-8000-000000000003', outsider:'00000000-0000-4000-8000-000000000004' };
test('real PostgreSQL role, row-policy, trigger and storage matrix', async t => {
  const pg = new PGlite({ extensions:{ pgcrypto } });
  t.after(() => pg.close());
  await pg.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA public, storage TO anon, authenticated;
    GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated;`);
  await pg.exec(await readFile(new URL('../../supabase/schema.sql', import.meta.url), 'utf8'));
  for (const [role,id] of Object.entries(ids)) {
    await pg.query('INSERT INTO auth.users VALUES ($1)', [id]);
    if(role!=='outsider') await pg.query('INSERT INTO public.staff_roles(user_id,role) VALUES ($1,$2)',[id,role]);
  }
  const as = async (identity,sql,params=[]) => {
    await pg.exec('RESET ROLE');
    await pg.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[ids[identity]||'']);
    await pg.exec('SET ROLE '+(identity==='anon'?'anon':'authenticated'));
    try { return await pg.query(sql,params); } finally { await pg.exec('RESET ROLE'); }
  };
  const denied = async (who, sql, params=[]) => assert.rejects(as(who,sql,params), e=>e.code==='42501');
  for (const who of ['admin','editor']) await t.test(who+' can create and manage staff records',async()=>{
    const event=await as(who,"INSERT INTO public.events(title,starts_at) VALUES ('Synthetic gathering','2030-01-06T15:00Z') RETURNING *");
    assert.equal(event.rows[0].created_by,ids[who]);assert.equal(event.rows[0].is_public,false);
    const contact=await as(who,"INSERT INTO public.contacts(first_name,last_name) VALUES ('Synthetic','Record') RETURNING id");
    const doc=await as(who,"INSERT INTO public.documents(title,file_name,storage_path,size_bytes,uploaded_by) VALUES ('Synthetic policy','fixture.pdf',$1,12,$2) RETURNING id",[ids[who]+'/fixture.pdf',ids[who]]);
    for (const [table,id] of [['events',event.rows[0].id],['contacts',contact.rows[0].id],['documents',doc.rows[0].id]]) {
      assert.equal((await as(who,`SELECT id FROM public.${table} WHERE id=$1`,[id])).rows.length,1);
      assert.equal((await as(who,`UPDATE public.${table} SET updated_at=now() WHERE id=$1 RETURNING id`,[id])).rows.length,1);
    }
    await as(who,"INSERT INTO storage.objects(bucket_id,name) VALUES ('church-documents',$1)",[ids[who]+'/fixture.pdf']);
    const extra=await as(who,"INSERT INTO storage.objects(bucket_id,name) VALUES ('church-documents',$1) RETURNING id",[ids[who]+'/temporary.pdf']);
    assert.equal((await as(who,"UPDATE storage.objects SET name=$1 WHERE id=$2 RETURNING id",[ids[who]+'/renamed.pdf',extra.rows[0].id])).rows.length,1);
    assert.equal((await as(who,'DELETE FROM storage.objects WHERE id=$1 RETURNING id',[extra.rows[0].id])).rows.length,1);
    const temporary=await as(who,"INSERT INTO public.events(title,starts_at) VALUES ('Temporary fixture',now()) RETURNING id");
    assert.equal((await as(who,'DELETE FROM public.events WHERE id=$1 RETURNING id',[temporary.rows[0].id])).rows.length,1);
    assert.ok((await as(who,'SELECT * FROM public.audit_log')).rows.length>=3);
  });
  for (const who of ['anon','outsider','viewer']) await t.test(who+' cannot write private records or grant a staff role',async()=>{
    for (const table of ['events','contacts','documents','audit_log','staff_roles']) {
      if(who==='anon') await denied(who,`SELECT * FROM public.${table}`);
      else assert.equal((await as(who,`SELECT * FROM public.${table}`)).rows.length>0,who==='viewer');
    }
    await denied(who,"INSERT INTO public.events(title,starts_at) VALUES ('Synthetic denied',now())");
    await denied(who,"INSERT INTO public.contacts(first_name,last_name) VALUES ('Synthetic','Denied')");
    await denied(who,"INSERT INTO public.documents(title,file_name,storage_path,size_bytes,uploaded_by) VALUES ('Denied','fixture.pdf','denied',1,$1)",[ids.viewer]);
    await denied(who,"INSERT INTO public.staff_roles(user_id,role) VALUES ($1,'admin')",[ids.outsider]);
    await denied(who,"INSERT INTO public.audit_log(action,entity_type) VALUES ('fabricated','contacts')");
    for(const table of ['events','contacts','documents']) {
      if(who==='anon') { await denied(who,`UPDATE public.${table} SET updated_at=now()`); await denied(who,`DELETE FROM public.${table}`); }
      else { assert.equal((await as(who,`UPDATE public.${table} SET updated_at=now() RETURNING id`)).rows.length,0); assert.equal((await as(who,`DELETE FROM public.${table} RETURNING id`)).rows.length,0); }
    }
    await denied(who,"INSERT INTO storage.objects(bucket_id,name) VALUES ('church-documents',$1)",[(ids[who]||ids.outsider)+'/denied.pdf']);
    assert.equal((await as(who,'SELECT * FROM storage.objects')).rows.length,who==='viewer'?2:0);
    assert.equal((await as(who,"UPDATE storage.objects SET name='denied' RETURNING id")).rows.length,0);
    assert.equal((await as(who,'DELETE FROM storage.objects RETURNING id')).rows.length,0);
  });
  await t.test('staff cannot falsify new upload ownership or reach another bucket',async()=>{
    await pg.query("INSERT INTO storage.objects(bucket_id,name) VALUES ('other-bucket','synthetic-existing-file')");
    await denied('editor',"INSERT INTO public.documents(title,file_name,storage_path,size_bytes,uploaded_by) VALUES ('Spoof','fixture.pdf',$1,12,$2)",[ids.admin+'/spoof.pdf',ids.admin]);
    await denied('editor',"INSERT INTO storage.objects(bucket_id,name) VALUES ('church-documents',$1)",[ids.admin+'/spoof.pdf']);
    await denied('editor',"INSERT INTO storage.objects(bucket_id,name) VALUES ('other-bucket',$1)",[ids.editor+'/fixture.pdf']);
    assert.equal((await as('viewer',"SELECT * FROM storage.objects WHERE bucket_id='other-bucket'")).rows.length,0);
    await assert.rejects(as('editor',"INSERT INTO public.documents(title,file_name,storage_path,size_bytes,uploaded_by) VALUES ('Too big','fixture.pdf',$1,52428801,$2)",[ids.editor+'/large.pdf',ids.editor]),e=>e.code==='23514');
  });
  await t.test('role revocation immediately denies reads and writes; anon cannot execute staff lookup',async()=>{
    await pg.query('DELETE FROM public.staff_roles WHERE user_id=$1',[ids.editor]);
    assert.equal((await as('editor','SELECT * FROM public.contacts')).rows.length,0);
    assert.equal((await as('editor','SELECT * FROM storage.objects')).rows.length,0);
    await denied('editor',"INSERT INTO public.events(title,starts_at) VALUES ('Revoked',now())");
    await denied('anon','SELECT private.current_staff_role()');
    assert.equal((await pg.query("SELECT public,file_size_limit FROM storage.buckets WHERE id='church-documents'")).rows[0].public,false);
  });
});
