-- Disposable database only. New writes, immutable final snapshots, grading and history isolation.
begin;
create function public.reliability_assert(ok boolean,message text) returns void language plpgsql as $$ begin
 if ok is distinct from true then raise exception 'ASSERT: %',message; end if;
end $$;
create function public.reliability_reject(sql text) returns void language plpgsql as $$ begin
 begin execute sql; exception when others then return; end; raise exception 'Expected rejection: %',sql;
end $$;
insert into public.daily_challenges(challenge_date) values('2026-11-18'),('2026-11-20') on conflict do nothing;
insert into public.daily_questions(challenge_date,position,question)
 select d,i,'Reliability date fixture '||d||' question '||i from unnest(array['2026-11-18'::date,'2026-11-20'::date]) d cross join generate_series(1,5) i on conflict do nothing;
update public.daily_challenges set published=true where challenge_date in ('2026-11-18','2026-11-20') and not published;
insert into public.daily_attempts(token_hash,challenge_date,input_mode) values(repeat('1',64),'2026-11-18','typing'),(repeat('2',64),'2026-11-20','typing');
insert into public.daily_answers(attempt_id,position,started_at,deadline)
 select id,1,clock_timestamp()-interval '6 seconds',clock_timestamp()+interval '20 seconds' from public.daily_attempts where token_hash in (repeat('1',64),repeat('2',64));

do $$
declare old_id uuid; current_id uuid; old_snapshot jsonb; w uuid:=gen_random_uuid(); newer uuid:=gen_random_uuid(); result jsonb; claim jsonb; scores jsonb:='{"Logic":8,"Creativity":8,"Relevance":8,"Clarity":8,"Depth":8}'; revision integer:=0; value text; now_day date:=(clock_timestamp() at time zone 'America/New_York')::date;
begin
 select id into old_id from public.daily_attempts where token_hash=repeat('1',64);
 select id into current_id from public.daily_attempts where token_hash=repeat('2',64);
 select to_jsonb(a) into old_snapshot from public.daily_attempts a where id=old_id;
 perform public.reliability_assert(public.daily_today()->>'date'=now_day::text,'authoritative Eastern date');
 perform public.reliability_assert((public.daily_today()->>'next_date_at')::timestamptz=((now_day+1)::timestamp at time zone 'America/New_York'),'Eastern next midnight');
 perform public.reliability_assert(('2026-03-09'::timestamp at time zone 'America/New_York')-('2026-03-08'::timestamp at time zone 'America/New_York')=interval '23 hours','spring DST day');
 perform public.reliability_assert(('2026-11-02'::timestamp at time zone 'America/New_York')-('2026-11-01'::timestamp at time zone 'America/New_York')=interval '25 hours','fall DST day');
 perform public.daily_begin_answer(repeat('2',64),1,w);
 foreach value in array array['A legitimate answer','A legitimate answe','An edited answer','','Replacement visible at submit'] loop
  revision:=revision+1; result:=public.daily_answer_v2(repeat('2',64),1,value,false,revision,w);
  perform public.reliability_assert(result->>'answer_text'=value,'full replacement persisted');
 end loop;
 perform public.reliability_assert(public.daily_answer_v2(repeat('2',64),1,'Stale old text',false,2,w)->>'status'='stale','out-of-order update rejected');
 perform public.reliability_reject(format('select public.daily_answer_v2(%L,2,''wrong position'',false,6,%L)',repeat('2',64),w));
 perform public.reliability_reject(format('select public.daily_answer_v2(%L,1,''unknown token'',true,6,%L)',repeat('3',64),w));
 perform public.reliability_assert((public.daily_state(repeat('2',64))->'rounds'->0->>'answer_revision')::int=5,'refresh returns saved revision');
 result:=public.daily_begin_answer(repeat('2',64),1,newer,w);
 perform public.reliability_assert(result->>'answer_text'='Replacement visible at submit','refresh returns canonical text');
 perform public.reliability_assert(public.daily_answer_v2(repeat('2',64),1,'Old tab final',true,99,w)->>'status'='superseded','refresh fences older tab');
 result:=public.daily_answer_v2(repeat('2',64),1,'Exact nonempty final answer',true,7,newer);
 perform public.reliability_assert(result->>'locked_at' is not null and result->>'final_answer_text'='Exact nonempty final answer','final durably acknowledged');
 perform public.daily_answer_v2(repeat('2',64),1,'',false,6,newer);
 perform public.daily_answer_v2(repeat('2',64),1,'',true,8,newer);
 perform public.reliability_reject(format('update public.daily_answers set answer_text='''' where attempt_id=%L',current_id));
 perform public.reliability_reject(format('update public.daily_answers set final_answer_text='''' where attempt_id=%L',current_id));
 claim:=public.daily_claim(repeat('2',64),1,'reliability');
 perform public.reliability_assert(claim->>'answer'='Exact nonempty final answer' and (claim->>'answer_confirmed')::boolean,'judge receives exact immutable nonempty final');
 perform public.reliability_assert(public.daily_claim(repeat('2',64),1,'reliability')->>'busy'='true','one judging lease');
 perform public.daily_finish(repeat('2',64),1,(claim->>'token')::uuid,scores,'test','test');
 perform public.daily_finish(repeat('2',64),1,gen_random_uuid(),scores,'duplicate','test');
 perform public.reliability_assert((select total=40 and answer_text=final_answer_text from public.daily_answers where attempt_id=current_id and position=1),'one score for same confirmed answer');
 perform public.reliability_assert((select to_jsonb(a)=old_snapshot from public.daily_attempts a where id=old_id),'November 18 unfinished attempt preserved');
 perform public.reliability_assert((select answer_text='' and state='active' from public.daily_answers where attempt_id=old_id),'new attempt cannot contaminate old answer');
 -- Real empty answers and timeout-without-answer retain zero scoring semantics.
 perform public.daily_begin_answer(repeat('1',64),1,w);
 perform public.daily_answer_v2(repeat('1',64),1,'',true,1,w);
 claim:=public.daily_claim(repeat('1',64),1,'reliability-empty');
 perform public.reliability_assert(claim->>'answer'='' and (claim->>'answer_confirmed')::boolean,'genuine empty final is confirmed');
 perform public.reliability_reject(format('select public.daily_finish(%L,1,%L,%L,''bad'',''test'')',repeat('1',64),(claim->>'token')::uuid,scores));
 perform public.daily_finish(repeat('1',64),1,(claim->>'token')::uuid,'{"Logic":0,"Creativity":0,"Relevance":0,"Clarity":0,"Depth":0}','empty','test');
end $$;
-- Arena's judge must reject an absent/mismatched canonical final, never substitute an empty draft.
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('50000000-0000-4000-8000-000000000001','integrity-a@example.test',now(),'{"username":"integrity_a"}'),
 ('50000000-0000-4000-8000-000000000002','integrity-b@example.test',now(),'{"username":"integrity_b"}');
insert into public.profiles(id,username) values('50000000-0000-4000-8000-000000000001','integrity_a'),('50000000-0000-4000-8000-000000000002','integrity_b') on conflict(id) do nothing;
do $$
declare a uuid:='50000000-0000-4000-8000-000000000001'; b uuid:='50000000-0000-4000-8000-000000000002'; mid uuid; wa uuid:=gen_random_uuid(); wb uuid:=gen_random_uuid(); claim jsonb; before_stats jsonb;
begin
 perform set_config('request.jwt.claim.sub',a::text,true); perform public.ranked_queue_match('typing',true);
 perform set_config('request.jwt.claim.sub',b::text,true); mid:=public.ranked_queue_match('typing',true);
 perform public.ranked_begin_answer(mid,wb);
 perform set_config('request.jwt.claim.sub',a::text,true); perform public.ranked_begin_answer(mid,wa);
 update public.matches set round_start=clock_timestamp()-interval '6 seconds' where id=mid;
 perform public.ranked_answer_v2(mid,'Nonempty A final',true,1,wa);
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.ranked_answer_v2(mid,'Nonempty B final',true,1,wb);
 select jsonb_agg(to_jsonb(p) order by id) into before_stats from public.profiles p where id in (a,b);
 update public.match_answers set answer_text='' where match_id=mid and player_id=a;
 perform public.reliability_reject(format('select public.ranked_claim(%L,%L)',mid,a));
 perform public.reliability_assert((select ranked_state='judge_pending' from public.matches where id=mid),'mismatch cannot start judging');
 perform public.reliability_assert((select jsonb_agg(to_jsonb(p) order by id)=before_stats from public.profiles p where id in (a,b)),'mismatch cannot change Elo');
 update public.match_answers set answer_text='Nonempty A final' where match_id=mid and player_id=a;
 claim:=public.ranked_claim(mid,a);
 perform public.reliability_assert(claim->'answers'->>a::text='Nonempty A final' and claim->'answers'->>b::text='Nonempty B final' and (claim->>'answers_confirmed')::boolean,'Arena claim reads exact canonical finals');
end $$;

set local role authenticated;
select public.reliability_reject('select public.daily_begin_answer(repeat(''2'',64),1,gen_random_uuid())');
select public.reliability_reject('select public.daily_answer_v2(repeat(''2'',64),1,''forged'',true,10,gen_random_uuid())');
reset role;
rollback;
