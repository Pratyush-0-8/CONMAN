begin;
do $$
declare a uuid:='81000000-0000-4000-8000-000000000001'; b uuid:='81000000-0000-4000-8000-000000000002';
 t uuid:=gen_random_uuid(); fresh uuid; mid uuid; s jsonb; extra numeric; saved timestamptz;
begin
 insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 (a,'timeout_a@example.test',now(),'{"username":"timeout_a"}'),(b,'timeout_b@example.test',now(),'{"username":"timeout_b"}');
 perform set_config('request.jwt.claim.sub',a::text,true);
 if public.ranked_search('typing',true,t) is not null then raise exception 'Lone player matched'; end if;
 perform public.ranked_search('voice',true,t);
 s:=public.ranked_state();
 if s->'queue'->>'attempt_id'<>t::text or s->'queue'->>'input_mode'<>'typing' or s->'queue'->>'expires_at' is not null then raise exception 'Duplicate request changed active attempt'; end if;
 -- First 20 seconds: no extension has been sampled; reconnect retains the original start.
 update public.ranked_queue set joined_at=clock_timestamp()-interval '19 seconds' where player_id=a;
 saved:=(select joined_at from public.ranked_queue where player_id=a);
 perform public.ranked_search('typing',false,t);
 if (select joined_at from public.ranked_queue where player_id=a)<>saved then raise exception 'Heartbeat reset start'; end if;
 -- Sample once at the boundary and preserve that exact random deadline across reconnects.
 update public.ranked_queue set joined_at=clock_timestamp()-interval '20 seconds' where player_id=a;
 s:=public.ranked_state();
 select extract(epoch from (expires_at-joined_at))-20,expires_at into extra,saved from public.ranked_queue where player_id=a;
 if extra<1 or extra>10 or extra<>trunc(extra) then raise exception 'Extension is not integer 1..10'; end if;
 perform public.ranked_state(); perform public.ranked_search('typing',false,t);
 if (select expires_at from public.ranked_queue where player_id=a)<>saved then raise exception 'Random deadline changed on retry'; end if;
 -- Expiry removes matchable membership but retains one terminal receipt through refresh.
 update public.ranked_queue set expires_at=clock_timestamp() where player_id=a;
 s:=public.ranked_state();
 if s->'queue'<>'null'::jsonb or s->'search'->>'status'<>'expired' then raise exception 'Timeout not restored'; end if;
 perform public.ranked_search('typing',false,t); perform public.ranked_search('typing',true,t);
 if exists(select 1 from public.ranked_queue where player_id=a) then raise exception 'Delayed join revived expired attempt'; end if;
 fresh:=gen_random_uuid();
 perform public.ranked_search('typing',true,fresh,t);
 perform public.ranked_cancel_search(t);
 if (select attempt_id from public.ranked_queue where player_id=a)<>fresh then raise exception 'Old tab cancelled retry'; end if;
 perform public.ranked_cancel_search(fresh); perform public.ranked_search('typing',true,fresh,t);
 if exists(select 1 from public.ranked_queue where player_id=a) then raise exception 'Delayed join revived cancelled search'; end if;
 t:=gen_random_uuid(); perform public.ranked_search('typing',true,t,fresh);
 -- A disconnected browser cannot be resurrected by its next heartbeat.
 update public.ranked_queue set last_seen=clock_timestamp()-interval '26 seconds' where player_id=a;
 perform public.ranked_search('typing',false,t);
 if exists(select 1 from public.ranked_queue where player_id=a) then raise exception 'Stale search revived'; end if;
 -- Immediate / first-20s / extension arrivals all use the same existing human pairing path.
 for i in 1..3 loop
   fresh:=gen_random_uuid(); perform public.ranked_search('typing',true,fresh,t); t:=fresh;
   if i=2 then update public.ranked_queue set joined_at=clock_timestamp()-interval '15 seconds' where player_id=a; end if;
   if i=3 then update public.ranked_queue set joined_at=clock_timestamp()-interval '20 seconds' where player_id=a; perform public.ranked_state(); end if;
   perform set_config('request.jwt.claim.sub',b::text,true);
   mid:=public.ranked_queue_match('voice',true);
   if mid is null then raise exception 'Human arrival % failed',i; end if;
   perform set_config('request.jwt.claim.sub',a::text,true);
   perform public.ranked_cancel_search(t);
   s:=public.ranked_state();
   if s->'match'->>'id'<>mid::text or (select count(*) from public.ranked_players where match_id=mid)<>2 then raise exception 'Cancellation lost committed match'; end if;
   if not (select is_ranked from public.matches where id=mid) then raise exception 'Ranked behavior changed'; end if;
   -- Fixture-only release, no fake judging or external calls.
   update public.ranked_players set released_at=clock_timestamp() where match_id=mid;
 end loop;
 if has_function_privilege('anon','public.ranked_search(text,boolean,uuid,uuid)','execute')
 or has_function_privilege('authenticated','public.ranked_queue_tick()','execute')
 or has_table_privilege('authenticated','public.ranked_search_receipts','update') then raise exception 'Search privileges are unsafe'; end if;
end $$;
rollback;
