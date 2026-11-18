-- Disposable database only. Run after the Daily Five migration. All data rolls back.
begin;
insert into public.daily_challenges(challenge_date) values((clock_timestamp() at time zone 'America/New_York')::date);
insert into public.daily_questions(challenge_date,position,question)
  select (clock_timestamp() at time zone 'America/New_York')::date,i,'Daily test question '||i from generate_series(1,5) i;
update public.daily_challenges set published=true where challenge_date=(clock_timestamp() at time zone 'America/New_York')::date;
set constraints daily_exactly_five immediate;

do $$
declare d date:=(clock_timestamp() at time zone 'America/New_York')::date; h text:=repeat('a',64); other text:=repeat('b',64);
 snapshot jsonb; original jsonb; claim jsonb; duplicate jsonb; dist jsonb; id uuid; rejected boolean; category text; p integer;
 scores jsonb:='{"Logic":8,"Creativity":8,"Relevance":8,"Clarity":8,"Depth":8}'; stamp timestamptz;
begin
 if (public.daily_today()->>'date')::date<>d then raise exception 'Wrong Eastern challenge date'; end if;
 rejected:=false;
 begin update public.daily_questions set question='Changed' where challenge_date=d and position=1; exception when others then rejected:=true; end;
 if not rejected then raise exception 'Published question changed'; end if;
 rejected:=false;
 begin
   insert into public.daily_challenges(challenge_date) values(d+1);
   insert into public.daily_questions select d+1,i,'Incomplete question '||i from generate_series(1,4) i;
   update public.daily_challenges set published=true where challenge_date=d+1;
 exception when others then rejected:=true; end;
 if not rejected then raise exception 'Published fewer than five questions'; end if;
 snapshot:=public.daily_start(h,'typing','test-ip-a',d); id:=(snapshot->>'id')::uuid;
 if snapshot->>'mode'<>'typing' or snapshot->>'position'<>'1' then raise exception 'Anonymous attempt failed'; end if;
 if (select deadline-started_at from public.daily_answers where attempt_id=id and position=1)<>interval '25 seconds' then raise exception 'Typing timing wrong'; end if;
 original:=snapshot;
 snapshot:=public.daily_start(h,'voice','test-ip-a',d);
 if snapshot->>'id'<>original->>'id' or snapshot->'rounds'->0->>'started_at'<>original->'rounds'->0->>'started_at' or snapshot->>'mode'<>'typing' then raise exception 'Repeated creation reset attempt'; end if;
 rejected:=false;
 begin perform public.daily_state(repeat('c',64)); exception when insufficient_privilege then rejected:=true; end;
 if not rejected then raise exception 'Unknown attempt credential accepted'; end if;
 rejected:=false;
 begin perform public.daily_next(h,1); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Skipped an unanswered question'; end if;
 rejected:=false;
 begin perform public.daily_answer(h,1,'Too early',false); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Input allowed during thinking'; end if;
 -- Second attempt has a different credential, separate answers, and Voice timing.
 snapshot:=public.daily_start(other,'voice','test-ip-b',d);
 if snapshot->>'id'=id::text then raise exception 'Cross-attempt identity collision'; end if;
 if (select deadline-started_at from public.daily_answers where attempt_id=(snapshot->>'id')::uuid)<>interval '20 seconds' then raise exception 'Voice timing wrong'; end if;
 -- Five sequential real responses, each finalized and graded once.
 for p in 1..5 loop
   update public.daily_answers set started_at=clock_timestamp()-interval '6 seconds',deadline=clock_timestamp()+interval '18 seconds' where attempt_id=id and position=p;
   perform public.daily_answer(h,p,'Answer',false);
   rejected:=false;
   begin perform public.daily_answer(h,p,'Edited',false); exception when others then rejected:=true; end;
   if not rejected then raise exception 'Append-only rule bypassed'; end if;
   perform public.daily_answer(h,p,'Answer with reasoning',true);
   perform public.daily_answer(h,p,'Duplicate changed answer',true);
   if (select answer_text from public.daily_answers where attempt_id=id and position=p)<>'Answer with reasoning' then raise exception 'Finalized answer changed'; end if;
   if (public.daily_state(other)->'rounds'->0->>'answer_text')<>'' then raise exception 'Cross-attempt answer leak'; end if;
   claim:=public.daily_claim(h,p,'test-ip-a'); duplicate:=public.daily_claim(h,p,'test-ip-a');
   if claim->>'token' is null or duplicate->>'busy'<>'true' then raise exception 'Duplicate grading claim'; end if;
   if p=1 then
     foreach category in array array['Logic','Creativity','Relevance','Clarity','Depth'] loop
       rejected:=false;
       begin perform public.daily_finish(h,p,(claim->>'token')::uuid,jsonb_set(scores,array[category],'7.5'),'bad','test'); exception when others then rejected:=true; end;
       if not rejected then raise exception 'Fractional category accepted'; end if;
     end loop;
     perform public.daily_fail(h,p,(claim->>'token')::uuid,'Temporary failure',false);
     if public.daily_claim(h,p,'test-ip-a')->>'busy'<>'true' then raise exception 'Retry cooldown ignored'; end if;
     update public.daily_answers set retry_at=clock_timestamp()-interval '1 second' where attempt_id=id and position=p;
     claim:=public.daily_claim(h,p,'test-ip-a');
   end if;
   snapshot:=public.daily_finish(h,p,(claim->>'token')::uuid,scores,'Reasoned answer','test');
   perform public.daily_finish(h,p,gen_random_uuid(),scores,'Duplicate','test');
   if (select count(*) from public.daily_answers where attempt_id=id and position=p)<>1 then raise exception 'Duplicate finalized response'; end if;
   if p<5 then
     if exists(select 1 from public.daily_answers where attempt_id=id and position=p+1) then raise exception 'Next timer started automatically'; end if;
     snapshot:=public.daily_next(h,p);
     stamp:=(snapshot->'rounds'->p->>'started_at')::timestamptz;
     snapshot:=public.daily_next(h,p);
     if (snapshot->'rounds'->p->>'started_at')::timestamptz<>stamp or (snapshot->>'position')::integer<>p+1 then raise exception 'Duplicate Next reset or skipped timer'; end if;
   end if;
 end loop;
 if snapshot->>'status'<>'complete' or (snapshot->>'final_score')::integer<>200 then raise exception 'Wrong persisted final total'; end if;
 if (select sum(total) from public.daily_answers where attempt_id=id)<>200 then raise exception 'Final total differs from persisted question totals'; end if;
 dist:=public.daily_distribution(h);
 if (dist->>'count')::integer<>1 or (dist->>'percentile')::numeric<>50 then raise exception 'Small population/tie percentile wrong'; end if;
 if (select sum((b->>'count')::integer) from jsonb_array_elements(dist->'bins') b)<>1 then raise exception 'Partial attempt entered histogram'; end if;
 -- Known distribution: 100, 200, 200, 250 => score 200 has midpoint percentile 50.
 insert into public.daily_attempts(token_hash,challenge_date,input_mode,status,final_score,completed_at)
   values(repeat('d',64),d,'typing','complete',100,clock_timestamp()),(repeat('e',64),d,'typing','complete',200,clock_timestamp()),(repeat('f',64),d,'typing','complete',250,clock_timestamp());
 insert into public.daily_answers(attempt_id,position,started_at,deadline,state,locked_at,scores,total)
   select at.id,i,clock_timestamp()-interval '30 seconds',clock_timestamp()-interval '5 seconds','graded',clock_timestamp(),
     jsonb_build_object('Logic',at.final_score/25,'Creativity',at.final_score/25,'Relevance',at.final_score/25,'Clarity',at.final_score/25,'Depth',at.final_score/25),at.final_score/5
   from public.daily_attempts at cross join generate_series(1,5) i where at.token_hash in (repeat('d',64),repeat('e',64),repeat('f',64));
 -- A superficially completed row without five graded answers must still be excluded.
 insert into public.daily_attempts(token_hash,challenge_date,input_mode,status,final_score,completed_at) values(repeat('9',64),d,'typing','complete',225,clock_timestamp());
 dist:=public.daily_distribution(h);
 if (dist->>'count')::integer<>4 or (dist->>'percentile')::numeric<>50 then raise exception 'Population ties are inconsistent'; end if;
 if (dist->'bins'->24->>'count')::integer<>1 then raise exception '250 histogram endpoint missing'; end if;
 -- Expiration persists blanks and never restarts a saved clock on refresh.
 update public.daily_answers set deadline=clock_timestamp()-interval '3 seconds' where attempt_id=(public.daily_state(other)->>'id')::uuid;
 snapshot:=public.daily_state(other); original:=public.daily_state(other);
 if snapshot->'rounds'->0->>'state'<>'locked' or snapshot->'rounds'->0->>'answer_text'<>'' or snapshot->'rounds'->0->>'deadline'<>original->'rounds'->0->>'deadline' then raise exception 'Expiration/refresh modified answer or deadline'; end if;
 claim:=public.daily_claim(other,1,'test-ip-b');
 rejected:=false;
 begin perform public.daily_finish(other,1,(claim->>'token')::uuid,scores,'bad empty score','test'); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Empty answer received invented score'; end if;
 perform public.daily_fail(other,1,(claim->>'token')::uuid,'Rate limited',true);
 if (public.daily_state(other)->'rounds'->0->>'retry_at')::timestamptz<clock_timestamp()+interval '55 seconds' then raise exception 'Rate-limit cooldown too short'; end if;
 update public.daily_answers set judge_attempts=3,retry_at=clock_timestamp()-interval '1 second' where attempt_id=(snapshot->>'id')::uuid;
 rejected:=false; begin perform public.daily_claim(other,1,'test-ip-b'); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Unbounded judge retries'; end if;
 perform public.daily_take_budget('test:budget',1,60);
 rejected:=false; begin perform public.daily_take_budget('test:budget',1,60); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Abuse budget bypassed'; end if;
 -- Even changing the IP bucket cannot bypass the hard global Groq budget.
 insert into public.daily_rate_buckets values('judge:global',date_trunc('day',clock_timestamp() at time zone 'America/New_York') at time zone 'America/New_York',1000,clock_timestamp()+interval '2 days')
   on conflict(bucket_key,window_start) do update set hits=1000;
 update public.daily_answers set judge_attempts=1 where attempt_id=(snapshot->>'id')::uuid;
 rejected:=false; begin perform public.daily_claim(other,1,'rotated-ip'); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Global Groq cap bypassed'; end if;
 if has_table_privilege('anon','public.daily_answers','select') or has_table_privilege('authenticated','public.daily_attempts','insert') then raise exception 'Public table access'; end if;
 if has_function_privilege('anon','public.daily_state(text)','execute') or has_function_privilege('authenticated','public.daily_finish(text,integer,uuid,jsonb,text,text)','execute') then raise exception 'Public privileged RPC access'; end if;
end $$;
rollback;
