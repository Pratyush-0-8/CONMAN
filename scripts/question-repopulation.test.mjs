import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { createLegacyFixture } from './sql-fixture.mjs'

test('staged replacement preserves active pools until cutover and pins existing Daily answers to their original questions',async()=>{
 const db=new PGlite(),target='202611200005_daily_question_snapshots.sql'
 try {
  await createLegacyFixture(db)
  for(const f of fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')&&f<target).sort()) await db.exec(fs.readFileSync('supabase/migrations/'+f,'utf8'))
  await db.exec(`insert into public.daily_challenges(challenge_date) values((clock_timestamp() at time zone 'America/New_York')::date);
   insert into public.daily_questions select (clock_timestamp() at time zone 'America/New_York')::date,i,'Original daily question '||i||'?' from generate_series(1,5)i;
   update public.daily_challenges set published=true;
   select public.daily_start(repeat('a',64),'typing','repopulation-test',(clock_timestamp() at time zone 'America/New_York')::date);
   update public.daily_answers set started_at=clock_timestamp()-interval '8 seconds';
   select public.daily_begin_answer(repeat('a',64),1,'84000000-0000-4000-8000-000000000001');
   select public.daily_answer_v2(repeat('a',64),1,'My durable original answer',true,1,'84000000-0000-4000-8000-000000000001');`)
  const before=(await db.query('select to_jsonb(a) a from public.daily_answers a')).rows
  await db.exec(fs.readFileSync('supabase/migrations/'+target,'utf8'))
  assert.deepEqual((await db.query('select to_jsonb(a) a from public.daily_answers a')).rows,before)
  await db.exec(fs.readFileSync('supabase/migrations/202611200006_question_situation_uniqueness.sql','utf8'))
  await db.query('insert into public.question_catalog(question) values($1)',['Your client refused a gift. How would you persuade the judge this protected a friendship from becoming an expensive competition?'])
  await assert.rejects(db.query('select public.qgen_validate($1,1)',[JSON.stringify(['Your client refused a gift. Why should the judge consider that a clever strategy for avoiding unwanted publicity and attention?'])]),/Duplicate/)
  await db.exec(fs.readFileSync('supabase/migrations/202611210001_question_catalog_retirement.sql','utf8'))
  await db.exec(fs.readFileSync('supabase/migrations/202611210002_question_situation_overlap.sql','utf8'))
  await db.query('insert into public.question_catalog(question) values($1)',['Your client, a hotel manager, removed all the mirrors from the guest rooms. What argument would show this improved the guest experience?'])
  await db.query('select public.qgen_validate($1,1)',[JSON.stringify(['Your client, a hotel manager, removed all the pillows from the guest rooms. What argument would persuade the judge this enhanced the stay?'])])
  await assert.rejects(db.query('select public.qgen_validate($1,1)',[JSON.stringify(['Your client refused a gift. Why should the judge consider that a clever strategy for avoiding unwanted publicity and attention?'])]),/Duplicate/)

  await db.exec(fs.readFileSync('supabase/ops/20261120_reframe_stage.sql','utf8'))
  await db.exec("update public.question_generation_jobs set enabled=true")
  const lease=(await db.query("select public.qgen_claim('arena_rotate',true,false) value")).rows[0].value
  const request=(await db.query("select public.qgen_request_begin($1,$2,'test',10) id",[lease.run_id,lease.token])).rows[0].id
  await db.query("select public.qgen_request_end($1,200,10,'{}',null,null)",[request])
  const source=fs.readFileSync('scripts/question-generation.test.mjs','utf8')
  const questions=Function('return '+source.match(/const questions=(\[[\s\S]*?\n\])/)[1])()
  const args=[lease.run_id,lease.token,request,JSON.stringify(questions)]
  assert.equal((await db.query('select public.qgen_rollout_commit($1,$2,$3,$4) n',args)).rows[0].n,10)
  assert.equal((await db.query('select public.qgen_rollout_commit($1,$2,$3,$4) n',args)).rows[0].n,10)
  assert.equal((await db.query('select count(*)::int n from public.ranked_questions')).rows[0].n,6)
  await db.query("select public.qgen_finish_job($1,$2)",[lease.run_id,lease.token])
  await db.query(`with added as (insert into public.question_catalog(question) values($1) returning id)
   insert into public.qgen_rollout_stage(catalog_id,generation_run_id) select id,$2 from added`,[questions[0]+'. Why should the judge reward this decision?',lease.run_id])
  await db.exec(fs.readFileSync('supabase/ops/20261120_reframe_curate.sql','utf8'))
  assert.equal((await db.query('select count(*)::int n from public.qgen_rollout_stage')).rows[0].n,10)
  assert.equal((await db.query('select count(*)::int n from public.ranked_questions')).rows[0].n,6)
  await db.query(`with added as (insert into public.question_catalog(question) select 'Your client made unusual fixture decision '||i||'. Why should the judge consider this sensible?' from generate_series(1,121)i returning id)
   insert into public.qgen_rollout_stage(catalog_id,generation_run_id) select id,$1 from added`,[lease.run_id])
  await db.exec(`insert into public.daily_question_queue(catalog_id,source,consumed_date,consumed_position) select c.id,'manual',q.challenge_date,q.position from public.daily_questions q join public.question_catalog c on c.question=q.question;`)
  await db.exec(fs.readFileSync('supabase/ops/20261120_reframe_cutover.sql','utf8'))
  const old=(await db.query("select public.daily_state(repeat('a',64)) s")).rows[0].s
  assert.equal(old.rounds[0].question,'Original daily question 1?')
  const claim=(await db.query("select public.daily_claim(repeat('a',64),1,'repopulation-test') c")).rows[0].c
  assert.equal(claim.question,'Original daily question 1?');assert.equal(claim.answer,'My durable original answer')
  const fresh=(await db.query("select public.daily_start(repeat('b',64),'typing','repopulation-fresh',(clock_timestamp() at time zone 'America/New_York')::date) s")).rows[0].s
  assert.equal(fresh.rounds[0].question,questions[0])
  assert.equal((await db.query('select count(*)::int n from public.daily_question_queue where consumed_date is null')).rows[0].n,20)
  assert.equal((await db.query('select count(*)::int n from public.ranked_questions')).rows[0].n,106)
  assert.equal((await db.query("select count(*)::int n from public.question_pool_archives where kind='daily_published'")).rows[0].n,5)
  assert.equal((await db.query("select count(*)::int n from public.question_pool_archives where kind='daily_assigned'")).rows[0].n,5)
  await assert.rejects(db.exec("update public.daily_questions set question='Unauthorized replacement'"),/immutable/)
 } finally {await db.close()}
})
