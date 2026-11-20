-- Disposable database only; all fixtures roll back.
begin;
create function public.timer_assert(ok boolean,message text) returns void language plpgsql as $$ begin
 if ok is distinct from true then raise exception 'ASSERT: %',message; end if;
end $$;
create function public.timer_reject(sql text) returns void language plpgsql as $$ begin
 begin execute sql; exception when others then return; end; raise exception 'Expected timing rejection: %',sql;
end $$;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('60000000-0000-4000-8000-000000000001','timer-a@example.test',now(),'{"username":"timer_a"}'),
 ('60000000-0000-4000-8000-000000000002','timer-b@example.test',now(),'{"username":"timer_b"}');
insert into public.profiles(id,username) values('60000000-0000-4000-8000-000000000001','timer_a'),('60000000-0000-4000-8000-000000000002','timer_b') on conflict(id) do nothing;
insert into public.daily_challenges(challenge_date) values((clock_timestamp() at time zone 'America/New_York')::date) on conflict do nothing;
insert into public.daily_questions(challenge_date,position,question) select (clock_timestamp() at time zone 'America/New_York')::date,i,'Timer question '||i from generate_series(1,5) i on conflict do nothing;
update public.daily_challenges set published=true where challenge_date=(clock_timestamp() at time zone 'America/New_York')::date and not published;
do $$
declare a uuid:='60000000-0000-4000-8000-000000000001'; b uuid:='60000000-0000-4000-8000-000000000002'; mid uuid; cid uuid; wa uuid:=gen_random_uuid(); wb uuid:=gen_random_uuid(); mode text; h text; d date:=(clock_timestamp() at time zone 'America/New_York')::date; s jsonb; saved timestamptz; id uuid;
begin
 perform set_config('request.jwt.claim.sub',a::text,true); perform public.ranked_queue_match('typing',true);
 perform set_config('request.jwt.claim.sub',b::text,true); mid:=public.ranked_queue_match('voice',true);
 perform public.timer_assert((select thinking_seconds=10 from public.matches where public.matches.id=mid),'new Arena thinks for 10s');
 perform public.timer_assert((select bool_and(p.deadline-m.round_start=case when p.input_mode='voice' then interval '35 seconds' else interval '45 seconds' end) from public.ranked_players p join public.matches m on m.id=p.match_id where m.id=mid),'both Arena modes derive deadlines from same start');
 perform public.timer_assert((public.ranked_state()->'match'->>'thinking_seconds')::int=10,'Arena refresh includes authoritative phase timing');
 select deadline into saved from public.ranked_players where match_id=mid and player_id=b;
 perform public.ranked_state();perform public.ranked_state();
 perform public.timer_assert((select deadline=saved from public.ranked_players where match_id=mid and player_id=b),'Arena refresh never resets deadline');
 perform public.ranked_begin_answer(mid,wb);
 update public.matches set round_start=clock_timestamp()-interval '9 seconds' where public.matches.id=mid;
 perform public.timer_reject(format('select public.ranked_answer_v2(%L,''early'',false,1,%L)',mid,wb));
 update public.matches set round_start=clock_timestamp()-interval '11 seconds' where public.matches.id=mid;
 perform public.ranked_answer_v2(mid,'Voice valid before deadline',true,1,wb);
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.ranked_begin_answer(mid,wa);
 perform public.ranked_answer_v2(mid,'Typing valid before deadline',true,1,wa);
 perform public.timer_assert((select count(*)=2 from public.match_answers where match_id=mid),'both timed finals persist independently');
 update public.matches set ranked_state='complete' where public.matches.id=mid;
 update public.ranked_players set released_at=clock_timestamp() where match_id=mid;
 perform public.social_follow(b,true); perform public.social_heartbeat(gen_random_uuid(),true);
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.social_follow(a,true); perform public.social_heartbeat(gen_random_uuid(),true);
 perform set_config('request.jwt.claim.sub',a::text,true);cid:=public.social_send_challenge(b,'typing');
 perform set_config('request.jwt.claim.sub',b::text,true);mid:=public.social_respond_challenge(cid,'accept','voice');
 perform public.timer_assert((select thinking_seconds=10 and not is_ranked from public.matches where public.matches.id=mid),'friend match uses new timing and stays unranked');
 perform public.timer_assert((select bool_and(p.deadline-m.round_start=case when p.input_mode='voice' then interval '35 seconds' else interval '45 seconds' end) from public.ranked_players p join public.matches m on m.id=p.match_id where m.id=mid),'friend deadlines share same clock');
 foreach mode in array array['typing','voice'] loop
  h:=case when mode='typing' then repeat('b',64) else repeat('c',64) end;
  s:=public.daily_start(h,mode,'timer-'||mode,d);id:=(s->>'id')::uuid;
  perform public.timer_assert((s->'rounds'->0->>'thinking_seconds')::int=10,'Daily phase metadata persisted');
  perform public.timer_assert((s->'rounds'->0->>'answer_seconds')::int=case when mode='typing' then 35 else 25 end,'Daily answer duration metadata');
  perform public.timer_assert((select deadline-started_at=case when mode='typing' then interval '45 seconds' else interval '35 seconds' end from public.daily_answers where attempt_id=id and position=1),'Daily total duration');
  select deadline into saved from public.daily_answers where attempt_id=id and position=1;
  perform public.daily_state(h);perform public.daily_start(h,mode,'timer-'||mode,d);
  perform public.timer_assert((select deadline=saved from public.daily_answers where attempt_id=id and position=1),'Daily refresh/start retry does not restart timer');
  perform public.daily_begin_answer(h,1,wa);
  update public.daily_answers set started_at=clock_timestamp()-interval '9 seconds' where attempt_id=id and position=1;
  perform public.timer_reject(format('select public.daily_answer_v2(%L,1,''early'',false,1,%L)',h,wa));
  update public.daily_answers set started_at=clock_timestamp()-interval '11 seconds' where attempt_id=id and position=1;
  perform public.daily_answer_v2(h,1,'Backspace and replacement remain valid',false,1,wa);
  perform public.daily_answer_v2(h,1,'Replaced final',true,2,wa);
  perform public.timer_assert((select final_answer_text='Replaced final' from public.daily_answers where attempt_id=id and position=1),'timed final is durable');
 end loop;
end $$;
rollback;
