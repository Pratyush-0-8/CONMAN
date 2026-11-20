begin;
-- Existing rows retain their original settings and persisted deadlines. Only new rows use the new defaults.
alter table public.matches add column thinking_seconds smallint not null default 5 check(thinking_seconds in (5,10));
alter table public.matches alter column thinking_seconds set default 10;
alter table public.daily_attempts
 add column thinking_seconds smallint not null default 5 check(thinking_seconds in (5,10)),
 add column typing_seconds smallint not null default 20 check(typing_seconds in (20,35)),
 add column voice_seconds smallint not null default 15 check(voice_seconds in (15,25));
alter table public.daily_attempts alter column thinking_seconds set default 10;
alter table public.daily_attempts alter column typing_seconds set default 35;
alter table public.daily_attempts alter column voice_seconds set default 25;

create or replace function public.ranked_queue_match(p_mode text default 'voice', p_join boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); mid uuid; me public.ranked_queue%rowtype; other public.ranked_queue%rowtype; q text; start_at timestamptz;
begin
  if uid is null or not exists(select 1 from auth.users where id=uid and email_confirmed_at is not null) then raise exception 'Verified account required'; end if;
  if p_mode not in ('voice','typing') then raise exception 'Invalid input mode'; end if;
  -- Serializes pairing/cancellation; queue rows and unique active membership prevent duplicate pairing.
  perform pg_advisory_xact_lock(214734601);
  select rp.match_id into mid from public.ranked_players rp join public.matches m on m.id=rp.match_id
    where rp.player_id=uid and rp.released_at is null;
  if mid is not null then return mid; end if;
  delete from public.ranked_queue where last_seen < clock_timestamp()-interval '25 seconds';
  if p_join then
    insert into public.ranked_queue(player_id,input_mode) values(uid,p_mode) on conflict(player_id) do nothing;
  end if;
  update public.ranked_queue set last_seen=clock_timestamp() where player_id=uid;
  select * into me from public.ranked_queue where player_id=uid;
  if me.player_id is null then return null; end if;
  select oq.* into other from public.ranked_queue oq
    join public.profiles op on op.id=oq.player_id join public.profiles mp on mp.id=uid
    where oq.player_id<>uid and not exists(select 1 from public.ranked_players rp where rp.player_id=oq.player_id and rp.released_at is null)
    and abs(op.elo-mp.elo) <= 100 + 25 * extract(epoch from (clock_timestamp()-least(me.joined_at,oq.joined_at)))
    order by abs(op.elo-mp.elo),oq.joined_at limit 1 for update of oq;
  if other.player_id is null then return null; end if;
  select question into q from public.ranked_questions order by random() limit 1;
  if q is null then raise exception 'Question bank is empty'; end if;
  start_at := clock_timestamp()+interval '4 seconds';
  -- Legacy mode is retained for compatibility; each participant has their own authoritative mode.
  insert into public.matches(player1_id,player2_id,mode,opponent_type,question,status,ranked_state,round_start)
    values(uid,other.player_id,'voice','human',q,'brainstorming','active',start_at) returning id into mid;
  insert into public.ranked_players(match_id,player_id,username,input_mode,deadline)
    select mid,p.id,p.username,case when p.id=uid then me.input_mode else other.input_mode end,
      start_at+interval '10 seconds'+case when (case when p.id=uid then me.input_mode else other.input_mode end)='voice' then interval '25 seconds' else interval '35 seconds' end
    from public.profiles p where p.id in (uid,other.player_id);
  insert into public.ranked_drafts(match_id,player_id) values(mid,uid),(mid,other.player_id);
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
 start_at+interval '10 seconds'+case when (case when p.id=c.sender_id then c.sender_mode else p_mode end)='voice' then interval '25 seconds' else interval '35 seconds' end
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
  insert into public.daily_answers(attempt_id,position,started_at,deadline) values(mid,1,t,t+interval '10 seconds'+case when p_mode='voice' then interval '25 seconds' else interval '35 seconds' end);
  return public.daily_state(p_hash);
end $$;

create or replace function public.daily_next(p_hash text,p_position integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype; t timestamptz;
begin
  select * into a from public.daily_attempts where token_hash=p_hash for update;
  if a.id is null then raise exception 'Invalid attempt token' using errcode='42501'; end if;
  if p_position<a.current_position or a.status='complete' then return public.daily_state(p_hash); end if;
  if p_position<>a.current_position or p_position>=5 or not exists(select 1 from public.daily_answers where attempt_id=a.id and position=p_position and state='graded') then raise exception 'Finish the current question first'; end if;
  t:=clock_timestamp()+interval '750 milliseconds';
  update public.daily_attempts set current_position=p_position+1 where id=a.id;
  insert into public.daily_answers(attempt_id,position,started_at,deadline) values(a.id,p_position+1,t,t+make_interval(secs=>a.thinking_seconds+case when a.input_mode='voice' then a.voice_seconds else a.typing_seconds end));
  return public.daily_state(p_hash);
end $$;

create or replace function public.ranked_answer_v2(p_match uuid,p_text text,p_final boolean,p_revision bigint,p_writer uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare received_at timestamptz:=statement_timestamp(); uid uuid:=auth.uid(); m public.matches%rowtype; p public.ranked_players%rowtype; d public.ranked_drafts%rowtype;
begin
 if uid is null then raise exception 'Sign in required'; end if;
 if p_text is null or char_length(p_text)>12000 then raise exception 'Invalid answer length'; end if;
 if p_final is null or p_writer is null or p_revision is null or p_revision<1 or p_revision>9007199254740991 then raise exception 'Invalid answer revision'; end if;
 -- The existing match lock serializes answer writes, timeout locking, judge claims and finalization.
 select * into m from public.matches where id=p_match for update;
 select * into p from public.ranked_players where match_id=p_match and player_id=uid;
 if p.player_id is null then raise exception 'Not a participant'; end if;
 if p.locked_at is not null or m.ranked_state<>'active' then
  return public.ranked_answer_snapshot(p_match,uid,'locked');
 end if;
 select * into strict d from public.ranked_drafts where match_id=p_match and player_id=uid;
 if d.writer_id is distinct from p_writer then return public.ranked_answer_snapshot(p_match,uid,'superseded'); end if;
 if p_revision<=d.revision then return public.ranked_answer_snapshot(p_match,uid,'stale'); end if;
 if received_at<m.round_start+make_interval(secs=>m.thinking_seconds) then raise exception 'Thinking period is not over'; end if;
 -- Keep the existing input deadlines and bounded transport grace. Late drafts cannot extend the round.
 if received_at>p.deadline and not (p_final and received_at<=p.deadline+
    case when p.input_mode='voice' then interval '1500 milliseconds' else interval '500 milliseconds' end) then
  perform public.ranked_tick(p_match);
  return public.ranked_answer_snapshot(p_match,uid,'expired');
 end if;
 update public.ranked_drafts set answer_text=p_text,revision=p_revision where match_id=p_match and player_id=uid;
 if p_final then
  update public.ranked_players set locked_at=clock_timestamp() where match_id=p_match and player_id=uid;
  insert into public.match_answers(match_id,player_id,is_bot,answer_text,submitted_at)
   values(p_match,uid,false,p_text,clock_timestamp());
 end if;
 perform public.ranked_tick(p_match);
 return public.ranked_answer_snapshot(p_match,uid,case when p_final then 'locked' else 'saved' end);
end $$;

create or replace function public.daily_answer_v2(p_hash text,p_position integer,p_text text,p_final boolean,p_revision bigint,p_writer uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare received_at timestamptz:=statement_timestamp(); a public.daily_attempts%rowtype; r public.daily_answers%rowtype;
begin
 select * into a from public.daily_attempts where token_hash=p_hash for update;
 if a.id is null then raise exception 'Invalid attempt token' using errcode='42501'; end if;
 if p_position is distinct from a.current_position then raise exception 'Not the current question'; end if;
 if p_text is null or length(p_text)>12000 then raise exception 'Invalid answer length'; end if;
 if p_writer is null or p_final is null or p_revision is null or p_revision<1 or p_revision>9007199254740991 then raise exception 'Invalid answer revision'; end if;
 select * into strict r from public.daily_answers where attempt_id=a.id and position=p_position;
 if r.state<>'active' then return public.daily_answer_snapshot(a.id,p_position,'locked'); end if;
 if r.writer_id is distinct from p_writer then return public.daily_answer_snapshot(a.id,p_position,'superseded'); end if;
 if p_revision<=r.revision then return public.daily_answer_snapshot(a.id,p_position,'stale'); end if;
 if received_at<r.started_at+make_interval(secs=>a.thinking_seconds) then raise exception 'Thinking period is not over'; end if;
 if received_at>r.deadline and not(p_final and received_at<=r.deadline+
 case when a.input_mode='voice' then interval '1500 milliseconds' else interval '500 milliseconds' end) then
  perform public.daily_tick(a.id); return public.daily_answer_snapshot(a.id,p_position,'expired');
 end if;
 update public.daily_answers set answer_text=p_text,revision=p_revision,state=case when p_final then 'locked' else 'active' end,
 locked_at=case when p_final then clock_timestamp() else null end where attempt_id=a.id and position=p_position;
 return public.daily_answer_snapshot(a.id,p_position,case when p_final then 'locked' else 'saved' end);
end $$;

create or replace function public.ranked_state(p_match uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); mid uuid; m public.matches%rowtype; players jsonb; reveal boolean;
begin
  if uid is null then raise exception 'Sign in required'; end if;
  if p_match is not null then
    select match_id into mid from public.ranked_players where match_id=p_match and player_id=uid;
    if mid is null then raise exception 'Not a participant'; end if;
  else
    select match_id into mid from public.ranked_players where player_id=uid and released_at is null;
  end if;
  if mid is null then
    return jsonb_build_object('server_now',clock_timestamp(),'match',null,'queue',(select to_jsonb(q) from public.ranked_queue q where player_id=uid));
  end if;
  perform public.ranked_tick(mid);
  select * into m from public.matches where id=mid;
  reveal := m.ranked_state <> 'active';
  select jsonb_agg(to_jsonb(p) || jsonb_build_object('elo',pr.elo,'wins',pr.wins,'losses',pr.losses,
    'answer_revision',case when p.player_id=uid then d.revision else null end,
    'answer_writer',case when p.player_id=uid then d.writer_id else null end,
    'answer_text',case when reveal or p.player_id=uid then d.answer_text else null end)) into players
    from public.ranked_players p join public.ranked_drafts d using(match_id,player_id) join public.profiles pr on pr.id=p.player_id where p.match_id=mid;
  return jsonb_build_object('server_now',clock_timestamp(),'queue',null,'match',jsonb_build_object(
    'id',m.id,'player1_id',m.player1_id,'player2_id',m.player2_id,'question',m.question,'state',m.ranked_state,
    'is_ranked',m.is_ranked,'thinking_seconds',m.thinking_seconds,'round_start',m.round_start,'completed_at',m.completed_at,'players',players,'judge_error',m.judge_error,
    'judge_retry_at',m.judge_retry_at,'judge_attempts',m.judge_attempts,'result',m.judge_result));
end $$;

create or replace function public.daily_state(p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype; rounds jsonb;
begin
  select * into a from public.daily_attempts where token_hash=p_hash for update;
  if a.id is null then raise exception 'Invalid attempt token' using errcode='42501'; end if;
  perform public.daily_tick(a.id);
  select jsonb_agg(jsonb_build_object('position',q.position,'question',case when r.started_at is not null then q.question else null end,
    'thinking_seconds',a.thinking_seconds,'answer_seconds',case when a.input_mode='voice' then a.voice_seconds else a.typing_seconds end,
    'answer_revision',r.revision,'answer_writer',r.writer_id,'locked_at',r.locked_at,'final_answer_text',r.final_answer_text,
    'started_at',r.started_at,'deadline',r.deadline,'answer_text',r.answer_text,'state',r.state,'scores',r.scores,'total',r.total,
    'explanation',r.explanation,'judge_error',r.judge_error,'retry_at',r.retry_at,'judge_lease_until',r.judge_lease_until,'judge_attempts',r.judge_attempts) order by q.position) into rounds
    from public.daily_questions q left join public.daily_answers r on r.attempt_id=a.id and r.position=q.position where q.challenge_date=a.challenge_date;
  return jsonb_build_object('server_now',clock_timestamp(),'id',a.id,'date',a.challenge_date,'mode',a.input_mode,
    'position',a.current_position,'status',a.status,'final_score',a.final_score,'rounds',rounds);
end $$;

-- A request queued before expiry must not time out later in-flight commands merely because a lock delayed its execution.
create or replace function public.ranked_tick(p_match uuid) returns void language plpgsql security definer set search_path = '' as $$
declare m public.matches%rowtype; p record;
begin
  select * into m from public.matches where id=p_match for update;
  if m.ranked_state <> 'active' then return; end if;
  for p in select * from public.ranked_players where match_id=p_match and locked_at is null
    and deadline + case when input_mode='voice' then interval '1500 milliseconds' else interval '500 milliseconds' end <= statement_timestamp()
  loop
    update public.ranked_players set locked_at=clock_timestamp() where match_id=p_match and player_id=p.player_id;
    insert into public.match_answers(match_id,player_id,is_bot,answer_text,submitted_at)
      select p_match,p.player_id,false,d.answer_text,clock_timestamp() from public.ranked_drafts d where d.match_id=p_match and d.player_id=p.player_id;
  end loop;
  if not exists(select 1 from public.ranked_players where match_id=p_match and locked_at is null) then
    update public.matches set ranked_state='judge_pending' where id=p_match;
  end if;
end $$;

create or replace function public.daily_tick(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype;
begin
  select * into a from public.daily_attempts where id=p_id for update;
  update public.daily_answers set state='locked',locked_at=clock_timestamp()
    where attempt_id=p_id and position=a.current_position and state='active'
      and deadline+case when a.input_mode='voice' then interval '1500 milliseconds' else interval '500 milliseconds' end<=statement_timestamp();
end $$;

notify pgrst,'reload schema';
commit;
