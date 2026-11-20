begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
-- One bounded receipt per player preserves terminal state across reconnects and makes retries CAS-safe.
create table public.ranked_search_receipts (
 player_id uuid primary key references public.profiles(id) on delete cascade,
 attempt_id uuid not null unique,
 input_mode text not null check(input_mode in ('typing','voice')),
 status text not null check(status in ('searching','expired','cancelled','matched'))
);
alter table public.ranked_search_receipts enable row level security;
revoke all on public.ranked_search_receipts from public,anon,authenticated;
alter table public.ranked_queue
 add column attempt_id uuid not null default gen_random_uuid(),
 add column expires_at timestamptz;
insert into public.ranked_search_receipts(player_id,attempt_id,input_mode,status)
 select player_id,attempt_id,input_mode,'searching' from public.ranked_queue;

-- Every removal (including friend acceptance) leaves a consistent terminal receipt.
create function public.ranked_queue_removed() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.ranked_search_receipts set status=case when exists(
   select 1 from public.ranked_players where player_id=old.player_id and released_at is null
 ) then 'matched' else 'expired' end
 where player_id=old.player_id and attempt_id=old.attempt_id and status='searching';
 return old;
end $$;
create trigger ranked_queue_removed after delete on public.ranked_queue
 for each row execute function public.ranked_queue_removed();

-- Internal only. Caller holds the existing global matchmaking/friend arbitration lock.
-- No scheduler is required for safety: every candidate is expired before it can be paired.
-- The extension is sampled once, on the first server operation at/after 20 seconds.
create function public.ranked_queue_tick() returns void language plpgsql security definer set search_path='' as $$
declare stamp timestamptz:=clock_timestamp();
begin
 update public.ranked_queue set expires_at=joined_at+make_interval(secs=>20+floor(random()*10)::integer+1)
   where expires_at is null and joined_at+interval '20 seconds'<=stamp;
 delete from public.ranked_queue where expires_at<=stamp or last_seen<stamp-interval '25 seconds';
end $$;

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
      start_at+interval '10 seconds'+case when (case when p.id=uid then me.input_mode else other.input_mode end)='voice' then interval '25 seconds' else interval '35 seconds' end
    from public.profiles p where p.id in (uid,other.player_id);
  insert into public.ranked_drafts(match_id,player_id) values(mid,uid),(mid,other.player_id);
  update public.ranked_search_receipts set status='matched' where player_id in (uid,other.player_id);
  delete from public.ranked_queue where player_id in (uid,other.player_id);
  return mid;
end $$;

create or replace function public.ranked_state(p_match uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); mid uuid; m public.matches%rowtype; players jsonb; reveal boolean;
begin
  if uid is null then raise exception 'Sign in required'; end if;
  -- Pairing, expiry and cancellation share one linearization point.
  perform pg_advisory_xact_lock(214734601);
  perform public.ranked_queue_tick();
  if p_match is not null then
    select match_id into mid from public.ranked_players where match_id=p_match and player_id=uid;
    if mid is null then raise exception 'Not a participant'; end if;
  else
    select match_id into mid from public.ranked_players where player_id=uid and released_at is null;
  end if;
  if mid is null then
    return jsonb_build_object('server_now',clock_timestamp(),'match',null,'queue',(select to_jsonb(q) from public.ranked_queue q where player_id=uid),
      'search',(select to_jsonb(r) from public.ranked_search_receipts r where player_id=uid));
  end if;
  perform public.ranked_tick(mid);
  select * into m from public.matches where id=mid;
  reveal := m.ranked_state <> 'active';
  select jsonb_agg(to_jsonb(p) || jsonb_build_object('elo',pr.elo,'wins',pr.wins,'losses',pr.losses,
    'answer_revision',case when p.player_id=uid then d.revision else null end,
    'answer_writer',case when p.player_id=uid then d.writer_id else null end,
    'answer_text',case when reveal or p.player_id=uid then d.answer_text else null end)) into players
    from public.ranked_players p join public.ranked_drafts d using(match_id,player_id) join public.profiles pr on pr.id=p.player_id where p.match_id=mid;
  return jsonb_build_object('server_now',clock_timestamp(),'queue',null,
    'search',(select to_jsonb(r) from public.ranked_search_receipts r where player_id=uid),'match',jsonb_build_object(
    'id',m.id,'player1_id',m.player1_id,'player2_id',m.player2_id,'question',m.question,'state',m.ranked_state,
    'is_ranked',m.is_ranked,'thinking_seconds',m.thinking_seconds,'round_start',m.round_start,'completed_at',m.completed_at,'players',players,'judge_error',m.judge_error,
    'judge_retry_at',m.judge_retry_at,'judge_attempts',m.judge_attempts,'result',m.judge_result));
end $$;

-- Compatibility for already-open clients. New clients supply attempt IDs explicitly.
create or replace function public.ranked_queue_match(p_mode text default 'voice',p_join boolean default false) returns uuid
language plpgsql security definer set search_path='' as $$
declare attempt uuid; previous uuid;
begin
 perform pg_advisory_xact_lock(214734601);
 perform public.ranked_queue_tick();
 select attempt_id into previous from public.ranked_search_receipts where player_id=auth.uid();
 select attempt_id into attempt from public.ranked_queue where player_id=auth.uid();
 return public.ranked_search(p_mode,p_join,coalesce(attempt,gen_random_uuid()),previous);
end $$;

create function public.ranked_cancel_search(p_attempt uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 perform pg_advisory_xact_lock(214734601);
 delete from public.ranked_queue where player_id=auth.uid() and attempt_id=p_attempt;
 update public.ranked_search_receipts set status='cancelled'
   where player_id=auth.uid() and attempt_id=p_attempt and status in ('searching','expired');
 -- An already-created match always wins; never touch match membership.
end $$;
create or replace function public.ranked_cancel_queue() returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.ranked_cancel_search((select attempt_id from public.ranked_search_receipts where player_id=auth.uid()));
end $$;

create or replace function public.social_available(p_player uuid) returns boolean language sql volatile security definer set search_path='' as $$
 select exists(select 1 from public.player_presence where player_id=p_player and available and last_seen>clock_timestamp()-interval '35 seconds')
 and not exists(select 1 from public.ranked_players where player_id=p_player and released_at is null)
 and not exists(select 1 from public.ranked_queue where player_id=p_player
   and last_seen>clock_timestamp()-interval '25 seconds' and coalesce(expires_at,joined_at+interval '30 seconds')>clock_timestamp());
$$;

revoke all on function public.ranked_queue_removed(),public.ranked_queue_tick(),public.ranked_search(text,boolean,uuid,uuid),public.ranked_cancel_search(uuid) from public,anon,authenticated;
grant execute on function public.ranked_search(text,boolean,uuid,uuid),public.ranked_cancel_search(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
