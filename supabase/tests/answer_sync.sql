-- Disposable databases only; fixtures and helpers roll back.
begin;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('30000000-0000-4000-8000-000000000001','answer-a@example.test',now(),'{"username":"answer_alice"}'),
 ('30000000-0000-4000-8000-000000000002','answer-b@example.test',now(),'{"username":"answer_bob"}'),
 ('30000000-0000-4000-8000-000000000003','answer-c@example.test',now(),'{"username":"answer_carol"}');
insert into public.profiles(id,username) values
 ('30000000-0000-4000-8000-000000000001','answer_alice'),
 ('30000000-0000-4000-8000-000000000002','answer_bob'),
 ('30000000-0000-4000-8000-000000000003','answer_carol') on conflict(id) do nothing;
create function public.test_assert(p_ok boolean,p_message text) returns void language plpgsql as $$ begin
 if p_ok is distinct from true then raise exception 'ASSERT: %',p_message; end if;
end $$;
create function public.test_reject(p_sql text) returns void language plpgsql as $$ begin
 begin execute p_sql; exception when others then return; end;
 raise exception 'Expected rejection: %',p_sql;
end $$;

do $$
declare a uuid:='30000000-0000-4000-8000-000000000001'; b uuid:='30000000-0000-4000-8000-000000000002'; c uuid:='30000000-0000-4000-8000-000000000003';
 mid uuid; wa uuid:=gen_random_uuid(); wb uuid:=gen_random_uuid(); refreshed uuid:=gen_random_uuid(); text_value text; i integer;
 state jsonb; result jsonb; before_elo integer;
begin
 perform set_config('request.jwt.claim.sub',a::text,true); perform public.ranked_queue_match('typing',true);
 perform set_config('request.jwt.claim.sub',b::text,true); mid:=public.ranked_queue_match('voice',true);
 -- Per-player ownership and editor/session acquisition during the thinking phase.
 perform public.test_assert(public.ranked_begin_answer(mid,wb)->>'status'='ready','recipient opens editor');
 perform public.test_assert(public.ranked_begin_answer(mid,wb)->>'status'='ready','session open is idempotent');
 perform public.test_reject(format('select public.ranked_answer_v2(%L,''too early'',false,1,%L)',mid,wb));
 perform set_config('request.jwt.claim.sub',c::text,true);
 perform public.test_reject(format('select public.ranked_begin_answer(%L,%L)',mid,gen_random_uuid()));
 perform public.test_reject(format('select public.ranked_answer_v2(%L,''forged'',true,1,%L)',mid,wa));
 perform set_config('request.jwt.claim.sub',a::text,true); perform public.ranked_begin_answer(mid,wa);
 perform public.test_reject(format('select public.ranked_answer(%L,''legacy'',false)',mid));
 update public.matches set round_start=clock_timestamp()-interval '11 seconds' where id=mid;
 i:=0;
 foreach text_value in array array['Hello world','Hello worl','Hi worl','Hi world','world','','你好','😀 replacing all text'] loop
  i:=i+1;
  result:=public.ranked_answer_v2(mid,text_value,false,i,wa);
  perform public.test_assert(result->>'status'='saved' and result->>'answer_text'=text_value,'full replacement persists: '||text_value);
 end loop;
 -- Force network delivery order opposite creation order, then repeated/mutated retries.
 result:=public.ranked_answer_v2(mid,'Newest revision',false,12,wa);
 perform public.test_assert(public.ranked_answer_v2(mid,'Delayed old autosave',false,10,wa)->>'status'='stale','out-of-order update ignored');
 perform public.test_assert(public.ranked_answer_v2(mid,'Same revision different text',false,12,wa)->>'status'='stale','revision reused cannot overwrite');
 perform public.test_assert((select answer_text='Newest revision' and revision=12 from public.ranked_drafts where match_id=mid and player_id=a),'newest persists');
 perform public.test_reject(format('select public.ranked_answer_v2(%L,repeat(''x'',12001),false,13,%L)',mid,wa));
 perform public.test_reject(format('select public.ranked_answer_v2(%L,''bad'',false,0,%L)',mid,wa));
 -- Peer drafts and writer/revision metadata stay private while the match is active.
 perform set_config('request.jwt.claim.sub',b::text,true);
 perform public.ranked_answer_v2(mid,'Voice interim changing',false,1,wb);
 perform public.ranked_answer_v2(mid,'Voice corrected interim',false,2,wb);
 state:=public.ranked_state(mid);
 perform public.test_assert(exists(select 1 from jsonb_array_elements(state->'match'->'players') p where p->>'player_id'=a::text and p->>'answer_text' is null and p->>'answer_writer' is null and p->>'answer_revision' is null),'opponent answer and write metadata hidden');
 perform public.test_assert((select answer_text='Voice corrected interim' from public.ranked_drafts where match_id=mid and player_id=b),'two-player isolation and voice replacement');
 -- Refresh takes over, returning the saved answer/revision and fencing delayed pre-refresh requests.
 perform set_config('request.jwt.claim.sub',a::text,true);
 result:=public.ranked_begin_answer(mid,refreshed,wa);
 perform public.test_assert(result->>'answer_text'='Newest revision' and (result->>'revision')::int=12,'refresh recovers server draft');
 perform public.test_assert(public.ranked_begin_answer(mid,wa)->>'status'='superseded','delayed old open cannot steal newer editor');
 perform public.test_assert(public.ranked_answer_v2(mid,'Old tab final',true,99,wa)->>'status'='superseded','old editor cannot submit even with higher revision');
 perform public.ranked_answer_v2(mid,'Refreshed latest edit',false,13,refreshed);
 -- Final overtakes an older autosave; neither late drafts nor conflicting final retries can change it.
 result:=public.ranked_answer_v2(mid,'Final replacement',true,15,refreshed);
 perform public.test_assert(result->>'status'='locked' and result->>'locked_at' is not null,'final locks');
 perform public.ranked_answer_v2(mid,'Late autosave',false,14,refreshed);
 perform public.ranked_answer_v2(mid,'Conflicting final',true,16,refreshed);
 perform public.test_assert((select answer_text='Final replacement' from public.ranked_drafts where match_id=mid and player_id=a),'locked answer immutable');
 perform public.test_assert((select count(*)=1 and min(answer_text)='Final replacement' from public.match_answers where match_id=mid and player_id=a),'one authoritative final answer');
 -- The same server deadlines and transport grace are preserved.
 perform set_config('request.jwt.claim.sub',b::text,true);
 update public.ranked_players set deadline=clock_timestamp()-interval '400 milliseconds' where match_id=mid and player_id=b;
 result:=public.ranked_answer_v2(mid,'Late draft',false,3,wb);
 perform public.test_assert(result->>'status'='expired' and result->>'answer_text'='Voice corrected interim','late draft rejected');
 result:=public.ranked_answer_v2(mid,'Final voice transcript',true,4,wb);
 perform public.test_assert(result->>'locked_at' is not null and result->>'answer_text'='Final voice transcript','voice final grace');
 perform public.test_assert(public.ranked_state(mid)->'match'->>'state'='judge_pending','both final answers trigger existing judge lifecycle');
 -- Keep the rest of the regression transaction independent of claims/finalizer; release this fixture as owner.
 update public.matches set ranked_state='complete',completed_at=clock_timestamp() where id=mid;
 update public.ranked_players set released_at=clock_timestamp() where match_id=mid;
 perform set_config('request.jwt.claim.sub',a::text,true); perform public.ranked_queue_match('typing',true);
 perform set_config('request.jwt.claim.sub',b::text,true); mid:=public.ranked_queue_match('typing',true);
 perform public.ranked_begin_answer(mid,wb);
 update public.matches set round_start=clock_timestamp()-interval '11 seconds' where id=mid;
 update public.ranked_players set deadline=clock_timestamp()-interval '100 milliseconds' where match_id=mid and player_id=b;
 result:=public.ranked_answer_v2(mid,'Typing final within existing grace',true,1,wb);
 perform public.test_assert(result->>'locked_at' is not null and result->>'answer_text'='Typing final within existing grace','typing final grace');
 perform set_config('request.jwt.claim.sub',a::text,true); perform public.ranked_begin_answer(mid,wa);
 perform public.ranked_answer_v2(mid,'Last received draft',false,1,wa);
 update public.ranked_players set deadline=clock_timestamp()-interval '2 seconds' where match_id=mid and player_id=a;
 result:=public.ranked_answer_v2(mid,'Too late final',true,2,wa);
 perform public.test_assert(result->>'status'='expired' and result->>'answer_text'='Last received draft' and result->>'locked_at' is not null,'late final uses actual saved text and reports expiry');
 perform public.test_assert((select count(*)=2 from public.match_answers where match_id=mid),'deadline locking has no duplicate final rows');
end $$;

select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',true);
set local role authenticated;
select public.test_reject('select public.ranked_answer_snapshot(gen_random_uuid(),''30000000-0000-4000-8000-000000000001'',''saved'')');
select public.test_reject('update public.ranked_drafts set answer_text=''forged'',revision=9000');
reset role;
set local role anon;
select public.test_reject('select public.ranked_begin_answer(gen_random_uuid(),gen_random_uuid())');
select public.test_reject('select public.ranked_answer_v2(gen_random_uuid(),''anonymous'',true,1,gen_random_uuid())');
reset role;
rollback;
