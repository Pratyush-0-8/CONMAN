-- Run only on a disposable/test Supabase database, after the migration. All fixtures roll back.
begin;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('10000000-0000-4000-8000-000000000001','ranked-a@example.test',now(),'{"username":"ranked_test_a"}'),
 ('10000000-0000-4000-8000-000000000002','ranked-b@example.test',now(),'{"username":"ranked_test_b"}'),
 ('10000000-0000-4000-8000-000000000003','ranked-c@example.test',now(),'{"username":"ranked_test_c"}');
insert into public.profiles(id,username) values
 ('10000000-0000-4000-8000-000000000001','ranked_test_a'),
 ('10000000-0000-4000-8000-000000000002','ranked_test_b'),
 ('10000000-0000-4000-8000-000000000003','ranked_test_c') on conflict(id) do nothing;

do $$
declare a uuid:='10000000-0000-4000-8000-000000000001'; b uuid:='10000000-0000-4000-8000-000000000002'; c uuid:='10000000-0000-4000-8000-000000000003';
 mid uuid; repeated uuid; state jsonb; first_claim jsonb; second_claim jsonb; saved jsonb; again jsonb; before_elo integer;
 scores1 jsonb:='{"Logic":8,"Creativity":8,"Relevance":8,"Clarity":8,"Depth":8}';
 scores2 jsonb:='{"Logic":6,"Creativity":6,"Relevance":6,"Clarity":6,"Depth":6}'; rejected boolean;
 category text; invalid jsonb; side integer;
begin
 perform set_config('request.jwt.claim.sub',a::text,true);
 if public.ranked_queue_match('voice',true) is not null then raise exception 'Matched a lone player'; end if;
 perform public.ranked_queue_match('typing',true);
 if (select count(*) from public.ranked_queue where player_id=a)<>1 then raise exception 'Duplicate queue entry'; end if;
 perform set_config('request.jwt.claim.sub',b::text,true);
 mid:=public.ranked_queue_match('typing',true);
 if mid is null then raise exception 'Cross-mode pairing failed'; end if;
 if (select status from public.matches where id=mid) is distinct from 'brainstorming' then raise exception 'Incorrect initial legacy match status'; end if;
 repeated:=public.ranked_queue_match('typing',true);
 if repeated<>mid or (select count(*) from public.ranked_players where match_id=mid)<>2 then raise exception 'Duplicate pairing'; end if;
 if (select player1_id=player2_id from public.matches where id=mid) then raise exception 'Self match'; end if;
 if (select deadline from public.ranked_players where match_id=mid and player_id=b)-(select deadline from public.ranked_players where match_id=mid and player_id=a)<>interval '5 seconds' then raise exception 'Mode deadlines are not synchronized'; end if;
 -- Start input without sleeping. Both still derive their time from one saved round_start.
 update public.matches set round_start=clock_timestamp()-interval '6 seconds' where id=mid;
 perform set_config('request.jwt.claim.sub',a::text,true);
 perform public.ranked_answer(mid,'A real voice answer',true);
 perform public.ranked_answer(mid,'duplicate overwrite',true);
 state:=public.ranked_state(mid);
 if state->'match'->>'state'<>'active' then raise exception 'Judged before both answers locked'; end if;
 if (select answer_text from public.ranked_drafts where match_id=mid and player_id=a)<>'A real voice answer' then raise exception 'Duplicate submission overwrote answer'; end if;
 perform set_config('request.jwt.claim.sub',b::text,true);
 state:=public.ranked_state(mid);
 if exists(select 1 from jsonb_array_elements(state->'match'->'players') p where p->>'player_id'=a::text and p->>'answer_text' is not null) then raise exception 'Opponent answer leaked'; end if;
 perform public.ranked_answer(mid,'Typed',false);
 rejected:=false;
 begin perform public.ranked_answer(mid,'Edited',false); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Typing mutation accepted'; end if;
 perform public.ranked_answer(mid,'Typed answer',true);
 if (public.ranked_state(mid)->'match'->>'state')<>'judge_pending' then raise exception 'Both locked did not trigger judging'; end if;
 rejected:=false;
 begin perform public.ranked_claim(mid,c); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Non-member judge request accepted'; end if;
 first_claim:=public.ranked_claim(mid,a); second_claim:=public.ranked_claim(mid,b);
 if first_claim->>'token' is null or second_claim->>'busy'<>'true' then raise exception 'Duplicate judge claim'; end if;
 before_elo:=(select elo from public.profiles where id=a);
 rejected:=false;
 begin perform public.ranked_finalize(mid,(first_claim->>'token')::uuid,'{"Logic":99}',scores2,'test'); exception when others then rejected:=true; end;
 if not rejected or (select elo from public.profiles where id=a)<>before_elo then raise exception 'Malformed scores changed ratings'; end if;
 foreach category in array array['Logic','Creativity','Relevance','Clarity','Depth'] loop
   invalid:=jsonb_set(scores1,array[category],'6.5'::jsonb);
   for side in 1..2 loop
     rejected:=false;
     begin
       perform public.ranked_finalize(mid,(first_claim->>'token')::uuid,
         case when side=1 then invalid else scores1 end,case when side=2 then invalid else scores2 end,'test');
     exception when others then rejected:=true; end;
     if not rejected then raise exception 'Decimal score accepted for player % category %',side,category; end if;
     if (select elo from public.profiles where id=a)<>before_elo or (select elo from public.profiles where id=b)<>500 then raise exception 'Invalid score changed ratings'; end if;
   end loop;
 end loop;
 -- player1 is B (the second entrant), so B wins and A loses.
 saved:=public.ranked_finalize(mid,(first_claim->>'token')::uuid,scores1,scores2,'test');
 again:=public.ranked_finalize(mid,gen_random_uuid(),scores2,scores1,'test');
 if saved<>again then raise exception 'Finalization not idempotent'; end if;
 if (select elo from public.profiles where id=b)<>516 or (select elo from public.profiles where id=a)<>484 then raise exception 'Incorrect K=32 ELO'; end if;
 if (select wins from public.profiles where id=b)<>1 or (select losses from public.profiles where id=a)<>1 then raise exception 'Stats updated more than once'; end if;
 if (select count(*) from public.match_answers where match_id=mid)<>2 then raise exception 'Duplicate answer rows'; end if;
 if has_function_privilege('authenticated','public.ranked_finalize(uuid,uuid,jsonb,jsonb,text)','execute') then raise exception 'Client can finalize'; end if;
 if has_table_privilege('authenticated','public.profiles','update') or has_column_privilege('authenticated','public.profiles','elo','update') then raise exception 'Client can change ELO'; end if;
 perform public.ranked_release(mid);
 perform set_config('request.jwt.claim.sub',a::text,true); perform public.ranked_release(mid);
 -- Stale queue cleanup and cancellation.
 perform set_config('request.jwt.claim.sub',c::text,true); perform public.ranked_queue_match('voice',true); perform public.ranked_cancel_queue();
 perform public.ranked_queue_match('voice',false);
 if exists(select 1 from public.ranked_queue where player_id=c) then raise exception 'Canceled heartbeat requeued player'; end if;
 perform public.ranked_queue_match('voice',true); update public.ranked_queue set last_seen=clock_timestamp()-interval '30 seconds' where player_id=c;
 perform set_config('request.jwt.claim.sub',a::text,true); perform public.ranked_queue_match('typing',true);
 if exists(select 1 from public.ranked_queue where player_id=c) then raise exception 'Stale queue survived'; end if;
 perform public.ranked_cancel_queue();
 -- Same-mode pairing, expiry of empty answers, draw statistics, and negative-rating floor.
 perform public.ranked_queue_match('typing',true);
 perform set_config('request.jwt.claim.sub',b::text,true); mid:=public.ranked_queue_match('typing',true);
 update public.ranked_players set deadline=clock_timestamp()-interval '3 seconds' where match_id=mid;
 state:=public.ranked_state(mid);
 if state->'match'->>'state'<>'judge_pending' then raise exception 'Deadlines did not lock empty answers'; end if;
 if exists(select 1 from public.ranked_drafts where match_id=mid and answer_text<>'') then raise exception 'Invented answer text'; end if;
 first_claim:=public.ranked_claim(mid,b); perform public.ranked_finalize(mid,(first_claim->>'token')::uuid,scores1,scores1,'test');
 if (select draws from public.profiles where id=a)<>1 or (select draws from public.profiles where id=b)<>1 then raise exception 'Draw stats missing'; end if;
 perform public.ranked_release(mid); perform set_config('request.jwt.claim.sub',a::text,true); perform public.ranked_release(mid);
 update public.profiles set elo=0 where id=a;
 perform public.ranked_queue_match('voice',true); perform set_config('request.jwt.claim.sub',b::text,true);
 -- Widen this test queue to pair ratings far apart without sleeping.
 update public.ranked_queue set joined_at=clock_timestamp()-interval '1 minute' where player_id=a;
 mid:=public.ranked_queue_match('voice',true);
 update public.ranked_players set deadline=clock_timestamp()-interval '3 seconds' where match_id=mid;
 perform public.ranked_state(mid); first_claim:=public.ranked_claim(mid,b);
 perform public.ranked_finalize(mid,(first_claim->>'token')::uuid,scores1,scores2,'test');
 if (select elo from public.profiles where id=a)<0 then raise exception 'Negative ELO'; end if;
end $$;
rollback;
