-- Disposable/test database only, after the generation migration. All fixtures roll back.
begin;
-- Synthetic questions deliberately vary several content tokens to test hundreds of unique rows.
create function pg_temp.gen_question(i integer) returns text language sql as $$
  select format('Why could orchard%s lantern%s harbor%s meadow%s pottery%s puzzle%s quietly improve everyday decisions?',i,i,i,i,i,i);
$$;

do $$
declare claim jsonb; request_id uuid; result jsonb; questions jsonb; before_count integer; prior_catalog integer;
 old_ids bigint[]; queue_ids bigint[]; target date:=(clock_timestamp() at time zone 'America/New_York')::date+1;
 protected_id bigint; protected_text text; rejected boolean; n integer; b integer; i integer;
 a uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='20000000-0000-4000-8000-000000000002';
begin
 if public.qgen_claim('daily_refill')->>'skip'<>'disabled' then raise exception 'Generation enabled by default'; end if;
 if exists(select 1 from public.question_generation_jobs where enabled) then raise exception 'Jobs must start disabled'; end if;
 update public.question_generation_jobs set enabled=true;
 if not public.qgen_near('A busy museum invites visitors to rearrange its signs; why might this improve their experience?',
   'Why might visitors improve their experience when a busy museum invites them to rearrange signs?') then raise exception 'Near duplicate detection failed'; end if;
 if public.qgen_normalize('  WHY might clocks, clocks?! ')<>'why might clocks clocks' then raise exception 'Normalization failed'; end if;
 -- Exact 10-hour gates and nightly local-time selection (both sides of DST).
 if public.qgen_publication_date('2026-11-19 04:29:59+00')<>date '2026-11-18'
   or public.qgen_publication_date('2026-11-19 04:30:00+00')<>date '2026-11-19'
   or public.qgen_publication_date('2026-07-02 03:30:00+00')<>date '2026-07-02'
   or public.qgen_publication_date('2026-03-08 07:00:00+00')<>date '2026-03-08' then raise exception 'Eastern publishing/DST boundary failed'; end if;
 claim:=public.qgen_claim('daily_publish',true);
 rejected:=false;
 begin perform public.qgen_publish((claim->>'run_id')::uuid,(claim->>'token')::uuid,target); exception when others then rejected:=true; end;
 if not rejected or exists(select 1 from public.daily_challenges where challenge_date=target) then raise exception 'Insufficient FIFO published a partial challenge'; end if;
 perform public.qgen_finish_job((claim->>'run_id')::uuid,(claim->>'token')::uuid,'Expected inventory shortage');
 -- Manual questions can exceed the replenishment target and have deterministic FIFO identities.
 select jsonb_agg(pg_temp.gen_question(x) order by x) into questions from generate_series(1,36) x;
 if public.qgen_enqueue_manual(questions)<>36 then raise exception 'Manual enqueue failed'; end if;
 select array_agg(id order by id) into queue_ids from (select id from public.daily_question_queue order by id limit 5) first_five;
 rejected:=false; begin perform public.qgen_enqueue_manual(jsonb_build_array(upper(pg_temp.gen_question(1)))); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Normalized duplicate accepted'; end if;
 claim:=public.qgen_claim('daily_refill',true);
 if claim->>'skip'<>'reserve full' or (select count(*) from public.daily_question_queue where consumed_date is null)<>36 then raise exception 'Manual stock was capped or needless generation claimed'; end if;
 if (select next_due_at-cycle_started_at from public.question_generation_jobs where job='daily_refill')<>interval '10 hours' then raise exception 'Not a true ten-hour interval'; end if;
 update public.question_generation_jobs set next_due_at=clock_timestamp()+interval '9 hours 59 minutes' where job='daily_refill';
 if public.qgen_claim('daily_refill')->>'skip'<>'not due' then raise exception 'Refill gate ran early'; end if;
 -- Publishing/retry consume exactly the oldest five once.
 claim:=public.qgen_claim('daily_publish',true);
 result:=public.qgen_publish((claim->>'run_id')::uuid,(claim->>'token')::uuid,target);
 if result->'queue_ids'<>to_jsonb(queue_ids) then raise exception 'FIFO ordering failed'; end if;
 if (select count(*) from public.daily_questions where challenge_date=target)<>5 or not (select published from public.daily_challenges where challenge_date=target) then raise exception 'Challenge publication incomplete'; end if;
 if exists(select 1 from public.daily_questions d join public.daily_question_queue q on q.consumed_date=d.challenge_date and q.consumed_position=d.position join public.question_catalog cat on cat.id=q.catalog_id where d.challenge_date=target and d.question<>cat.question) then raise exception 'Question positions differ from FIFO'; end if;
 result:=public.qgen_publish((claim->>'run_id')::uuid,(claim->>'token')::uuid,target);
 if result->>'already_published'<>'true' or (select count(*) from public.daily_question_queue where consumed_date is not null)<>5 then raise exception 'Repeated publication consumed again'; end if;
 perform public.qgen_finish_job((claim->>'run_id')::uuid,(claim->>'token')::uuid);
 -- One generated Daily batch is exactly five and is idempotent.
 claim:=public.qgen_claim('daily_refill',true);
 if public.qgen_claim('daily_refill',true)->>'skip'<>'already running' then raise exception 'Concurrent refill got two leases'; end if;
 request_id:=public.qgen_request_begin((claim->>'run_id')::uuid,(claim->>'token')::uuid,'test-model',5);
 perform public.qgen_request_end(request_id,200,5,'{"input_tokens":100}',null,'test-request');
 select jsonb_agg(pg_temp.gen_question(x)) into questions from generate_series(101,105) x;
 if public.qgen_commit_batch((claim->>'run_id')::uuid,(claim->>'token')::uuid,request_id,questions)<>5 then raise exception 'Wrong Daily batch size'; end if;
 perform public.qgen_commit_batch((claim->>'run_id')::uuid,(claim->>'token')::uuid,request_id,questions);
 if (select count(*) from public.daily_question_queue)<>41 then raise exception 'Repeated batch inserted duplicates'; end if;
 perform public.qgen_finish_job((claim->>'run_id')::uuid,(claim->>'token')::uuid);
 -- Initial Arena fill: add ten at a time, never retire below capacity, then cap at 150.
 select count(*) into before_count from public.ranked_questions;
 if before_count<>6 then raise exception 'Representative schema must start with six original Arena questions'; end if;
 for b in 1..15 loop
   claim:=public.qgen_claim('arena_rotate',true,true);
   request_id:=public.qgen_request_begin((claim->>'run_id')::uuid,(claim->>'token')::uuid,'test-model',10);
   perform public.qgen_request_end(request_id,200,10,null,null,'arena-fill');
   select jsonb_agg(pg_temp.gen_question(x)) into questions from generate_series(1000+b*10,1009+b*10) x;
   perform public.qgen_commit_batch((claim->>'run_id')::uuid,(claim->>'token')::uuid,request_id,questions);
   perform public.qgen_finish_job((claim->>'run_id')::uuid,(claim->>'token')::uuid);
   if b<15 and exists(select 1 from public.ranked_question_bank where retired_at is not null) then raise exception 'Premature retirement during initial fill'; end if;
   if (select count(*) from public.ranked_questions)<>least(150,6+b*10) then raise exception 'Wrong incremental fill size'; end if;
 end loop;
 if (select count(*) from public.ranked_questions)<>150 or (select count(*) from public.ranked_question_bank)<>156 then raise exception 'Initial pool fill lost questions or missed target'; end if;
 if public.qgen_claim('arena_rotate',true,true)->>'skip'<>'Arena pool full' then raise exception 'Initial fill kept generating'; end if;
 -- An in-progress match's question stays eligible in the active compatibility view.
 insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values(a,'gen-a@example.test',now(),'{"username":"gen_test_a"}'),(c,'gen-c@example.test',now(),'{"username":"gen_test_c"}');
 insert into public.profiles(id,username) values(a,'gen_test_a'),(c,'gen_test_c') on conflict(id) do nothing;
 select id,question into protected_id,protected_text from public.ranked_questions order by id limit 1;
 insert into public.matches(player1_id,player2_id,mode,opponent_type,question,status,ranked_state) values(a,c,'voice','human',protected_text,'speaking','active');
 claim:=public.qgen_claim('arena_rotate',true);
 request_id:=public.qgen_request_begin((claim->>'run_id')::uuid,(claim->>'token')::uuid,'test-model',10);
 perform public.qgen_request_end(request_id,200,10,null,null,'rotate');
 select jsonb_agg(pg_temp.gen_question(x)) into questions from generate_series(2001,2010) x;
 perform public.qgen_commit_batch((claim->>'run_id')::uuid,(claim->>'token')::uuid,request_id,questions);
 perform public.qgen_finish_job((claim->>'run_id')::uuid,(claim->>'token')::uuid);
 if not exists(select 1 from public.ranked_questions where id=protected_id) or (select count(*) from public.ranked_questions)<>150 then raise exception 'Rotation invalidated active match or pool size'; end if;
 if exists(select 1 from public.question_generation_jobs where job='arena_rotate' and
   (mod(extract(epoch from next_due_at)::numeric,21600)<>0 or next_due_at<=clock_timestamp() or next_due_at>clock_timestamp()+interval '6 hours')) then raise exception 'Arena gate is not the next six-hour UTC boundary'; end if;
 if public.qgen_claim('arena_rotate')->>'skip'<>'not due' then raise exception 'Arena rotation ran before its six-hour gate'; end if;
 if (select count(*) from public.ranked_question_bank where retired_at is not null)<>16 then raise exception 'Rotation did not archive ten oldest eligible questions'; end if;
 -- Invalid batch/duplicate rejection is atomic.
 claim:=public.qgen_claim('arena_rotate',true);
 request_id:=public.qgen_request_begin((claim->>'run_id')::uuid,(claim->>'token')::uuid,'test-model',10);
 perform public.qgen_request_end(request_id,200,10,null,null,'invalid');
 select count(*) into prior_catalog from public.question_catalog;
 select jsonb_agg(pg_temp.gen_question(x)) into questions from generate_series(2001,2010) x;
 rejected:=false; begin perform public.qgen_commit_batch((claim->>'run_id')::uuid,(claim->>'token')::uuid,request_id,questions); exception when others then rejected:=true; end;
 if not rejected or (select count(*) from public.question_catalog)<>prior_catalog or (select count(*) from public.ranked_questions)<>150 then raise exception 'Invalid generation partially changed the pool'; end if;
 perform public.qgen_finish_job((claim->>'run_id')::uuid,(claim->>'token')::uuid,'Expected validation failure');
 -- Conservative safety: no eligible old questions means no insertion/retirement at all.
 insert into public.matches(player1_id,player2_id,mode,opponent_type,question,status,ranked_state)
   select a,c,'voice','human',question,'speaking','active' from public.ranked_questions;
 claim:=public.qgen_claim('arena_rotate',true);
 request_id:=public.qgen_request_begin((claim->>'run_id')::uuid,(claim->>'token')::uuid,'test-model',10);
 perform public.qgen_request_end(request_id,200,10,null,null,'blocked');
 select jsonb_agg(pg_temp.gen_question(x)) into questions from generate_series(3001,3010) x;
 rejected:=false; begin perform public.qgen_commit_batch((claim->>'run_id')::uuid,(claim->>'token')::uuid,request_id,questions); exception when others then rejected:=true; end;
 if not rejected or (select count(*) from public.ranked_question_bank)<>166 then raise exception 'Safety rejection partially rotated questions'; end if;
 perform public.qgen_finish_job((claim->>'run_id')::uuid,(claim->>'token')::uuid,'Expected match protection');
 -- Request budgets and provider quota blocks apply across generators.
 claim:=public.qgen_claim('arena_rotate',true);
 update public.question_generation_settings set daily_request_limit=1;
 rejected:=false; begin perform public.qgen_request_begin((claim->>'run_id')::uuid,(claim->>'token')::uuid,'test-model',10); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Account-wide request budget bypassed'; end if;
 update public.question_generation_settings set daily_request_limit=80;
 request_id:=public.qgen_request_begin((claim->>'run_id')::uuid,(claim->>'token')::uuid,'test-model',10);
 perform public.qgen_request_end(request_id,429,0,null,'Quota exhausted','quota',true);
 rejected:=false; begin perform public.qgen_request_begin((claim->>'run_id')::uuid,(claim->>'token')::uuid,'test-model',10); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Provider quota did not stop further requests'; end if;
 if has_function_privilege('anon','public.qgen_claim(text,boolean,boolean)','execute') or has_function_privilege('authenticated','public.qgen_enqueue_manual(jsonb)','execute') then raise exception 'Public generator RPC'; end if;
 if has_table_privilege('anon','public.question_generation_settings','update') then raise exception 'Public job configuration'; end if;
end $$;
rollback;
