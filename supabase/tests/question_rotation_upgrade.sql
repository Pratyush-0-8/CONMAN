-- Disposable database only, after all migrations; representative original six-row bank.
-- Exercise transition from an already-filled legacy 200-question pool without deletion.
begin;
do $$
declare claim jsonb; request_id uuid; batch jsonb; old_question text; protected_question text;
  old_match uuid; active_match uuid; original_id bigint; protected_id bigint;
  a uuid:='30000000-0000-4000-8000-000000000001'; b uuid:='30000000-0000-4000-8000-000000000002';
begin
  if (select count(*) from public.ranked_questions)<>6 then raise exception 'Expected representative six-row bank'; end if;
  insert into public.ranked_question_bank(question)
    select format('Which legacy%s paper%s twig%s bottle%s candle%s feather%s best explains an unexpected choice?',i,i,i,i,i,i)
    from generate_series(1,194) i;
  update public.question_generation_jobs set enabled=true where job='arena_rotate';
  if public.qgen_claim('arena_rotate',true,true)->>'skip'<>'Arena pool full' then raise exception 'Oversized pool generated an unnecessary fill batch'; end if;
  insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
    values(a,'upgrade-a@example.test',now(),'{"username":"upgrade_a"}'),(b,'upgrade-b@example.test',now(),'{"username":"upgrade_b"}');
  insert into public.profiles(id,username) values(a,'upgrade_a'),(b,'upgrade_b') on conflict(id) do nothing;
  select id,question into original_id,old_question from public.ranked_questions order by id limit 1;
  select id,question into protected_id,protected_question from public.ranked_questions order by id offset 1 limit 1;
  insert into public.matches(player1_id,player2_id,mode,opponent_type,question,status,ranked_state)
    values(a,b,'voice','human',old_question,'completed','complete') returning id into old_match;
  insert into public.matches(player1_id,player2_id,mode,opponent_type,question,status,ranked_state)
    values(a,b,'voice','human',protected_question,'speaking','active') returning id into active_match;
  claim:=public.qgen_claim('arena_rotate',true);
  request_id:=public.qgen_request_begin((claim->>'run_id')::uuid,(claim->>'token')::uuid,'test-model',10);
  perform public.qgen_request_end(request_id,200,10,null,null,'legacy-upgrade');
  select jsonb_agg(format('Which umbrella%s lantern%s kettle%s compass%s window%s ribbon%s would you choose to solve a surprising problem?',i,i,i,i,i,i))
    into batch from generate_series(1,10) i;
  perform public.qgen_commit_batch((claim->>'run_id')::uuid,(claim->>'token')::uuid,request_id,batch);
  perform public.qgen_finish_job((claim->>'run_id')::uuid,(claim->>'token')::uuid);
  if (select count(*) from public.ranked_questions)<>150 or (select count(*) from public.ranked_question_bank)<>210
    or (select count(*) from public.ranked_question_bank where retired_at is not null)<>60 then
    raise exception 'Legacy pool did not transition atomically to 150 while preserving all historical rows';
  end if;
  if not exists(select 1 from public.ranked_question_bank where id=original_id and question=old_question and retired_at is not null)
    or not exists(select 1 from public.matches where id=old_match and question=old_question and status='completed' and ranked_state='complete') then
    raise exception 'Completed match history changed';
  end if;
  if not exists(select 1 from public.ranked_questions where id=protected_id and question=protected_question)
    or not exists(select 1 from public.matches where id=active_match and question=protected_question and ranked_state='active') then
    raise exception 'Unfinished match question retired';
  end if;
end $$;
rollback;
