-- Disposable databases only. Every fixture rolls back. The runner includes auth's profile trigger.
begin;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
('20000000-0000-4000-8000-000000000001','social-a@example.test',now(),'{"username":"social_alice"}'),
('20000000-0000-4000-8000-000000000002','social-b@example.test',now(),'{"username":"social_bob"}'),
('20000000-0000-4000-8000-000000000003','social-c@example.test',now(),'{"username":"social_carol"}'),
('20000000-0000-4000-8000-000000000004','social-d@example.test',null,'{"username":"social_unverified"}');
insert into public.profiles(id,username) values
('20000000-0000-4000-8000-000000000001','social_alice'),
('20000000-0000-4000-8000-000000000002','social_bob'),
('20000000-0000-4000-8000-000000000003','social_carol'),
('20000000-0000-4000-8000-000000000004','social_unverified') on conflict(id) do nothing;

-- Test helpers exist only inside this rollback transaction.
create function public.test_assert(p_ok boolean,p_message text) returns void language plpgsql as $$ begin
 if p_ok is distinct from true then raise exception 'ASSERT: %',p_message; end if;
end $$;
create function public.test_reject(p_sql text) returns void language plpgsql as $$ begin
 begin execute p_sql; exception when others then return; end;
 raise exception 'Expected rejection: %',p_sql;
end $$;

do $$
declare a uuid:='20000000-0000-4000-8000-000000000001'; b uuid:='20000000-0000-4000-8000-000000000002'; c uuid:='20000000-0000-4000-8000-000000000003';
 invitation uuid; mid uuid; again uuid; claim jsonb; scores jsonb:='{"Logic":8,"Creativity":8,"Relevance":8,"Clarity":8,"Depth":8}'; before_stats jsonb;
begin
 perform public.test_assert((select username='social_alice' and elo=500 from public.profiles where id=a),'profile creation');
 perform public.test_reject(format('insert into public.profiles(id,username) values(%L,%L)',gen_random_uuid(),'SOCIAL_ALICE'));
 -- Real case-insensitive uniqueness test with a valid auth identity, including trigger rollback.
 perform public.test_reject(format('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values(%L,%L,now(),%L)',gen_random_uuid(),'duplicate@example.test','{"username":"SOCIAL_ALICE"}'));
 perform set_config('request.jwt.claim.sub',a::text,true);
 perform public.test_assert(public.social_profile(a)->>'username'='social_alice','retrieve profile by stable id');
 perform public.test_assert(not (public.social_profile(a) ? 'email'),'public profile excludes email');
 perform public.test_assert(jsonb_array_length(public.social_players('search','SOCIAL_AL'))=1,'case-insensitive search');
 perform public.test_assert(jsonb_array_length(public.social_players('search','s'))=0,'bounded search');
 perform public.test_assert(jsonb_array_length(public.social_players('search','social_%'))=0,'search treats wildcard literally');
 perform public.social_set_display_name('Alice');
 perform public.test_assert(public.social_profile(a)->>'display_name'='Alice','display name');
 perform public.test_reject('select public.social_set_display_name(repeat(''a'',61))');
 perform public.test_reject(format('select public.social_follow(%L,true)',a));
 perform public.social_follow(b,true); perform public.social_follow(b,true);
 perform public.test_assert((select count(*)=1 from public.player_follows where follower_id=a),'duplicate follow is idempotent');
 perform public.test_assert(not public.social_friends(a,b),'one way is not friendship');
 perform public.test_assert((public.social_profile(b)->>'followers')::int=1,'follower count');
 perform public.test_assert(jsonb_array_length(public.social_players('following'))=1,'following list');
 perform public.test_reject(format('select public.social_send_challenge(%L)',b));
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.social_follow(a,true);
 perform public.test_assert(public.social_friends(a,b),'mutual friendship');
 perform public.test_assert(jsonb_array_length(public.social_players('friends'))=1,'friends list');
 perform public.test_assert(jsonb_array_length(public.social_players('followers'))=1,'followers list');
 perform public.social_heartbeat(gen_random_uuid(),true);
 perform set_config('request.jwt.claim.sub',a::text,true); perform public.social_heartbeat(gen_random_uuid(),true);
 invitation:=public.social_send_challenge(b,'voice');
 perform public.test_reject(format('select public.social_send_challenge(%L)',b));
 perform public.test_reject(format('select public.social_respond_challenge(%L,''accept'')',invitation));
 perform set_config('request.jwt.claim.sub',c::text,true);
 perform public.test_reject(format('select public.social_respond_challenge(%L,''accept'')',invitation));
 perform set_config('request.jwt.claim.sub',b::text,true);
 perform public.test_assert(jsonb_array_length(public.social_invitations()->'invitations')=1,'recipient invitation recovery');
 perform public.social_respond_challenge(invitation,'decline');
 perform public.test_assert((select status='declined' from public.friend_challenges where id=invitation),'decline');
 perform set_config('request.jwt.claim.sub',a::text,true); invitation:=public.social_send_challenge(b);
 perform public.social_respond_challenge(invitation,'cancel');
 perform public.test_assert((select status='cancelled' from public.friend_challenges where id=invitation),'sender cancellation');
 invitation:=public.social_send_challenge(b);
 update public.friend_challenges set created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' where id=invitation;
 perform set_config('request.jwt.claim.sub',b::text,true);
 perform public.test_assert(public.social_respond_challenge(invitation,'accept') is null,'expired acceptance rejected');
 perform public.test_assert((select status='expired' from public.friend_challenges where id=invitation),'expiry persisted');
 -- Unfollow removes friendship immediately and cancels invitations.
 perform set_config('request.jwt.claim.sub',a::text,true); invitation:=public.social_send_challenge(b);
 perform public.social_follow(b,false);
 perform public.test_assert(not public.social_friends(a,b),'unfollow removes friendship');
 perform public.test_assert((select status='cancelled' from public.friend_challenges where id=invitation),'unfollow cancels pending challenge');
 perform public.social_follow(b,true);
 -- A stale, hidden or busy session cannot accept; another live tab may still keep a player online.
 update public.player_presence set last_seen=clock_timestamp()-interval '40 seconds' where player_id=b;
 perform public.test_assert(not public.social_available(b),'stale disconnect is offline');
 perform public.test_reject(format('select public.social_send_challenge(%L)',b));
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.social_heartbeat(gen_random_uuid(),true);
 perform set_config('request.jwt.claim.sub',a::text,true); invitation:=public.social_send_challenge(b);
 update public.player_presence set available=false where player_id=b;
 perform set_config('request.jwt.claim.sub',b::text,true);
 perform public.test_assert(public.social_respond_challenge(invitation,'accept') is null,'offline acceptance cannot start');
 perform public.social_heartbeat(gen_random_uuid(),true);
 -- Ranked queue wins against a pending challenge; acceptance cancels safely.
 perform set_config('request.jwt.claim.sub',a::text,true); invitation:=public.social_send_challenge(b);
 perform public.ranked_queue_match('typing',true);
 perform set_config('request.jwt.claim.sub',b::text,true);
 perform public.test_assert(public.social_respond_challenge(invitation,'accept') is null,'queue conflict');
 perform set_config('request.jwt.claim.sub',a::text,true); perform public.ranked_cancel_queue();
 invitation:=public.social_send_challenge(b,'voice');
 select jsonb_agg(to_jsonb(p) order by id) into before_stats from public.profiles p where id in (a,b);
 perform set_config('request.jwt.claim.sub',b::text,true); mid:=public.social_respond_challenge(invitation,'accept','typing');
 again:=public.social_respond_challenge(invitation,'accept','typing');
 perform public.test_assert(mid is not null and mid=again,'duplicate acceptance returns same match');
 perform public.test_assert((select count(*)=2 from public.ranked_players where match_id=mid),'exactly two memberships');
 perform public.test_assert((select player1_id=a and player2_id=b and not is_ranked from public.matches where id=mid),'specific friends and unranked');
 perform public.test_assert(public.ranked_state()->'match'->>'id'=mid::text,'recipient refresh restores match');
 perform set_config('request.jwt.claim.sub',a::text,true);
 perform public.test_assert(public.ranked_state()->'match'->>'id'=mid::text,'sender refresh restores same match');
 perform public.test_assert(public.ranked_queue_match('typing',true)=mid,'ranked cannot create conflicting match');
 perform public.test_assert((select deadline from public.ranked_players where match_id=mid and player_id=b)-(select deadline from public.ranked_players where match_id=mid and player_id=a)=interval '5 seconds','friend match uses existing per-mode clocks');
 perform public.test_assert(not public.social_available(a),'in-match unavailable');
 perform public.test_reject(format('select public.social_send_challenge(%L)',b));
 update public.ranked_players set deadline=clock_timestamp()-interval '4 seconds' where match_id=mid;
 perform public.ranked_state(mid); claim:=public.ranked_claim(mid,a);
 perform public.ranked_finalize(mid,(claim->>'token')::uuid,scores,'{"Logic":6,"Creativity":6,"Relevance":6,"Clarity":6,"Depth":6}','social-test');
 perform public.ranked_finalize(mid,gen_random_uuid(),scores,scores,'social-test');
 perform public.test_assert(before_stats=(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p where id in (a,b)),'unranked preserves all ranked statistics exactly');
 perform public.test_assert((select bool_and(delta=0 and elo_before=elo_after) from public.ranked_players where match_id=mid),'unranked elo unchanged');
 perform public.test_assert((public.ranked_history()->0->>'is_ranked')::boolean=false,'history marks unranked');
 perform public.ranked_release(mid); perform set_config('request.jwt.claim.sub',b::text,true); perform public.ranked_release(mid);
 perform public.test_assert(not exists(select 1 from public.ranked_players where match_id=mid and released_at is null),'normal release works');
 perform set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000004',true);
 perform public.test_reject(format('select public.social_follow(%L,true)',b));
end $$;

-- Exercise actual database roles and RLS, rather than only security-definer code as owner.
select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000003',true);
set local role authenticated;
select public.test_assert((select count(*)=0 from public.friend_challenges),'RLS hides others invitations');
select public.test_reject('insert into public.player_follows(follower_id,following_id) values(''20000000-0000-4000-8000-000000000001'',''20000000-0000-4000-8000-000000000003'')');
select public.test_reject('update public.friend_challenges set recipient_id=''20000000-0000-4000-8000-000000000003''');
select public.test_reject('select * from public.player_presence');
select public.test_reject('select public.social_available(''20000000-0000-4000-8000-000000000001'')');
reset role;
select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select public.test_assert((select count(*)>0 from public.friend_challenges),'RLS shows own invitations');
select public.test_assert(public.social_profile('20000000-0000-4000-8000-000000000001')->>'username'='social_alice','role can read profile');
reset role;
select set_config('request.jwt.claim.sub','',true);
set local role anon;
select public.test_assert(public.social_profile('20000000-0000-4000-8000-000000000001')->>'username'='social_alice','anonymous public profile');
select public.test_reject('select public.social_send_challenge(''20000000-0000-4000-8000-000000000001'')');
select public.test_reject('select * from public.friend_challenges');
reset role;
rollback;
