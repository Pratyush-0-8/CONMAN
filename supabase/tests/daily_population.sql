-- Disposable database only, after 202611170002_daily_population_comparison.sql.
begin;
insert into public.daily_challenges(challenge_date) values('2001-01-01');
insert into public.daily_questions select '2001-01-01',i,'Population test question '||i from generate_series(1,5) i;
update public.daily_challenges set published=true where challenge_date='2001-01-01';

do $$
declare sample integer; player_score integer; hash text; id uuid; result jsonb;
begin
  for sample in 1..4 loop
    player_score:=case sample when 1 then 200 when 2 then 200 when 3 then 100 else 250 end;
    hash:=repeat(sample::text,64);
    insert into public.daily_attempts(token_hash,challenge_date,input_mode,status,final_score,completed_at)
      values(hash,'2001-01-01','typing','complete',player_score,clock_timestamp()) returning daily_attempts.id into id;
    insert into public.daily_answers(attempt_id,position,started_at,deadline,state,scores,total)
      select id,i,clock_timestamp(),clock_timestamp(),'graded',jsonb_build_object('Logic',player_score/25,'Creativity',player_score/25,'Relevance',player_score/25,'Clarity',player_score/25,'Depth',player_score/25),player_score/5 from generate_series(1,5) i;
    result:=public.daily_distribution(repeat('1',64));
    if (result->>'count')::integer<>sample then raise exception 'Incorrect completed population'; end if;
    if (result->>'below_count')::integer<>(case when sample<3 then 0 else 1 end) then raise exception 'Ties counted as players beaten'; end if;
  end loop;
  if round(100.0*(result->>'below_count')::integer/(result->>'count')::integer)<>25 then raise exception 'Incorrect strictly-below percentage'; end if;
  -- Same-day partial/falsely-completed and other-day attempts are excluded.
  insert into public.daily_attempts(token_hash,challenge_date,input_mode) values(repeat('5',64),'2001-01-01','typing');
  insert into public.daily_attempts(token_hash,challenge_date,input_mode,status,final_score,completed_at) values(repeat('6',64),'2001-01-01','voice','complete',10,clock_timestamp());
  result:=public.daily_distribution(repeat('1',64));
  if (result->>'count')::integer<>4 or (result->>'below_count')::integer<>1 then raise exception 'Unfinished attempt entered comparison'; end if;
  if has_function_privilege('anon','public.daily_distribution(text)','execute') or has_function_privilege('authenticated','public.daily_distribution(text)','execute') then raise exception 'Population RPC lost service-only permissions'; end if;
end $$;
rollback;
