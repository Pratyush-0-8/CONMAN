begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- Widen accepted saved timing rules; only defaults and NEW games change.
alter table public.matches drop constraint matches_thinking_seconds_check,
 add constraint matches_thinking_seconds_check check(thinking_seconds in (5,7,10)),
 alter column thinking_seconds set default 7;
alter table public.daily_attempts
 drop constraint daily_attempts_thinking_seconds_check,
 drop constraint daily_attempts_typing_seconds_check,
 drop constraint daily_attempts_voice_seconds_check,
 add constraint daily_attempts_thinking_seconds_check check(thinking_seconds in (5,7,10)),
 add constraint daily_attempts_typing_seconds_check check(typing_seconds in (20,25,35)),
 add constraint daily_attempts_voice_seconds_check check(voice_seconds in (15,20,25)),
 alter column thinking_seconds set default 7,
 alter column typing_seconds set default 25,
 alter column voice_seconds set default 20;

create or replace function public.ranked_search(p_mode text, p_join boolean, p_attempt uuid, p_previous uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); mid uuid; me public.ranked_queue%rowtype; other public.ranked_queue%rowtype; q text; start_at timestamptz; prior public.ranked_search_receipts%rowtype;
begin
  if uid is null or not exists(select 1 from auth.users where id=uid and email_confirmed_at is not null) then raise exception 'Verified account required'; end if;
  if p_mode is null or p_mode not in ('voice','typing') then raise exception 'Invalid input mode'; end if;
  -- Serializes pairing/cancellation; queue rows and unique active membership prevent duplicate pairing.
  perform pg_advisory_xact_lock(214734601);
  select rp.match_id into mid from public.ranked_players rp join public.matches m on m.id=rp.match_id
    where rp.player_id=uid and rp.released_at is null;
  if mid is not null then return mid; end if;
  perform public.ranked_queue_tick();
  select * into prior from public.ranked_search_receipts where player_id=uid;
  if p_attempt is null then raise exception 'Search attempt required'; end if;
  if p_join and (prior.player_id is null or (prior.attempt_id is distinct from p_attempt
      and prior.attempt_id=p_previous and prior.status<>'searching')) then
    insert into public.ranked_search_receipts(player_id,attempt_id,input_mode,status)
      values(uid,p_attempt,p_mode,'searching') on conflict(player_id) do update
      set attempt_id=excluded.attempt_id,input_mode=excluded.input_mode,status='searching';
    insert into public.ranked_queue(player_id,input_mode,attempt_id,joined_at,last_seen)
      values(uid,p_mode,p_attempt,clock_timestamp(),clock_timestamp());
  end if;
  -- A stale tab cannot heartbeat, restart or cancel a newer attempt.
  update public.ranked_queue set last_seen=clock_timestamp() where player_id=uid and attempt_id=p_attempt;
  select * into me from public.ranked_queue where player_id=uid and attempt_id=p_attempt;
  if me.player_id is null then return null; end if;
  select oq.* into other from public.ranked_queue oq
    join public.profiles op on op.id=oq.player_id join public.profiles mp on mp.id=uid
    where oq.player_id<>uid and not exists(select 1 from public.ranked_players rp where rp.player_id=oq.player_id and rp.released_at is null)
    and abs(op.elo-mp.elo) <= 100 + 25 * extract(epoch from (clock_timestamp()-least(me.joined_at,oq.joined_at)))
    order by abs(op.elo-mp.elo),oq.joined_at limit 1 for update of oq;
  if other.player_id is null then return null; end if;
  select question into q from public.ranked_questions order by random() limit 1;
  if q is null then raise exception 'Question bank is empty'; end if;
  -- Expiry is decided here under the same lock, immediately before match creation.
  perform public.ranked_queue_tick();
  if (select count(*) from public.ranked_queue where player_id in (uid,other.player_id))<>2 then return null; end if;
  start_at := clock_timestamp()+interval '4 seconds';
  -- Legacy mode is retained for compatibility; each participant has their own authoritative mode.
  insert into public.matches(player1_id,player2_id,mode,opponent_type,question,status,ranked_state,round_start)
    values(uid,other.player_id,'voice','human',q,'brainstorming','active',start_at) returning id into mid;
  insert into public.ranked_players(match_id,player_id,username,input_mode,deadline)
    select mid,p.id,p.username,case when p.id=uid then me.input_mode else other.input_mode end,
      start_at+interval '7 seconds'+case when (case when p.id=uid then me.input_mode else other.input_mode end)='voice' then interval '20 seconds' else interval '25 seconds' end
    from public.profiles p where p.id in (uid,other.player_id);
  insert into public.ranked_drafts(match_id,player_id) values(mid,uid),(mid,other.player_id);
  update public.ranked_search_receipts set status='matched' where player_id in (uid,other.player_id);
  delete from public.ranked_queue where player_id in (uid,other.player_id);
  return mid;
end $$;

create or replace function public.social_respond_challenge(p_challenge uuid,p_action text,p_mode text default 'typing') returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.social_verified(); c public.friend_challenges%rowtype; mid uuid; q text; start_at timestamptz;
begin
 if p_action is null or p_action not in ('accept','decline','cancel') or p_mode is null or p_mode not in ('voice','typing') then raise exception 'Invalid response'; end if;
 -- Same lock as ranked pairing, cancellation, question rotation and follow changes.
 perform pg_advisory_xact_lock(214734601);
 select * into c from public.friend_challenges where id=p_challenge for update;
 if c.id is null or uid not in (c.sender_id,c.recipient_id) then raise exception 'Invitation not found'; end if;
 if (p_action='cancel' and uid<>c.sender_id) or (p_action<>'cancel' and uid<>c.recipient_id) then raise exception 'Unauthorized invitation response'; end if;
 if c.status<>'pending' then return c.match_id; end if;
 if c.expires_at<=clock_timestamp() then update public.friend_challenges set status='expired' where id=c.id; return null; end if;
 if p_action<>'accept' then
  update public.friend_challenges set status=case when p_action='cancel' then 'cancelled' else 'declined' end where id=c.id; return null;
 end if;
 if not public.social_friends(c.sender_id,c.recipient_id) then update public.friend_challenges set status='cancelled' where id=c.id; return null; end if;
 if not public.social_available(c.sender_id) or not public.social_available(c.recipient_id) then
  update public.friend_challenges set status='cancelled' where id=c.id; return null;
 end if;
 select question into q from public.ranked_questions order by random() limit 1;
 if q is null then raise exception 'Question bank is empty'; end if;
 start_at:=clock_timestamp()+interval '4 seconds';
 insert into public.matches(player1_id,player2_id,mode,opponent_type,question,status,ranked_state,round_start,is_ranked)
 values(c.sender_id,c.recipient_id,'voice','human',q,'brainstorming','active',start_at,false) returning id into mid;
 insert into public.ranked_players(match_id,player_id,username,input_mode,deadline)
 select mid,p.id,p.username,case when p.id=c.sender_id then c.sender_mode else p_mode end,
 start_at+interval '7 seconds'+case when (case when p.id=c.sender_id then c.sender_mode else p_mode end)='voice' then interval '20 seconds' else interval '25 seconds' end
 from public.profiles p where p.id in (c.sender_id,c.recipient_id);
 insert into public.ranked_drafts(match_id,player_id) values(mid,c.sender_id),(mid,c.recipient_id);
 delete from public.ranked_queue where player_id in (c.sender_id,c.recipient_id);
 update public.friend_challenges set status='accepted',match_id=mid where id=c.id;
 update public.friend_challenges set status='cancelled' where status='pending' and (sender_id in (c.sender_id,c.recipient_id) or recipient_id in (c.sender_id,c.recipient_id));
 return mid;
end $$;

create or replace function public.daily_start(p_hash text,p_mode text,p_abuse_key text,p_date date) returns jsonb language plpgsql security definer set search_path='' as $$
declare d date:=(clock_timestamp() at time zone 'America/New_York')::date; mid uuid; t timestamptz;
begin
  if p_mode not in ('voice','typing') or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid attempt'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hash,0));
  if exists(select 1 from public.daily_attempts where token_hash=p_hash) then return public.daily_state(p_hash); end if;
  if p_date is distinct from d then raise exception 'The challenge date changed; refresh and try again'; end if;
  if not exists(select 1 from public.daily_challenges where challenge_date=d and published) then raise exception 'Today’s Daily Five is not published yet'; end if;
  perform public.daily_take_budget('create:'||p_abuse_key,10,86400);
  perform public.daily_take_budget('create:global',2000,86400);
  delete from public.daily_rate_buckets where expires_at<clock_timestamp();
  insert into public.daily_attempts(token_hash,challenge_date,input_mode) values(p_hash,d,p_mode) returning id into mid;
  t:=clock_timestamp()+interval '750 milliseconds';
  insert into public.daily_answers(attempt_id,position,started_at,deadline) values(mid,1,t,t+interval '7 seconds'+case when p_mode='voice' then interval '20 seconds' else interval '25 seconds' end);
  return public.daily_state(p_hash);
end $$;

notify pgrst,'reload schema';
commit;
