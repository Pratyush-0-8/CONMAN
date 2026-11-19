begin;

-- Abort on ambiguous legacy names rather than rename or discard production identities.
create unique index profiles_username_casefold_unique on public.profiles(lower(username));
alter table public.profiles add column if not exists display_name text check(char_length(display_name)<=60);
grant select(display_name) on public.profiles to anon,authenticated;
alter table public.matches add column is_ranked boolean not null default true;

create table public.player_follows (
 follower_id uuid not null references public.profiles(id) on delete cascade,
 following_id uuid not null references public.profiles(id) on delete cascade,
 created_at timestamptz not null default clock_timestamp(),
 primary key(follower_id,following_id), check(follower_id<>following_id)
);
create index player_follows_inbound on public.player_follows(following_id,follower_id);
create table public.player_presence (
 player_id uuid not null references public.profiles(id) on delete cascade,
 session_id uuid not null,
 last_seen timestamptz not null default clock_timestamp(),
 available boolean not null default true,
 primary key(player_id,session_id)
);
create table public.friend_challenges (
 id uuid primary key default gen_random_uuid(),
 sender_id uuid not null references public.profiles(id),
 recipient_id uuid not null references public.profiles(id),
 sender_mode text not null check(sender_mode in ('voice','typing')),
 status text not null default 'pending' check(status in ('pending','accepted','declined','cancelled','expired')),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default (clock_timestamp()+interval '60 seconds'),
 match_id uuid unique references public.matches(id),
 check(sender_id<>recipient_id), check(expires_at>created_at),
 check((status='accepted')=(match_id is not null))
);
create unique index friend_challenge_pair_pending on public.friend_challenges(least(sender_id,recipient_id),greatest(sender_id,recipient_id)) where status='pending';
create index friend_challenges_recipient on public.friend_challenges(recipient_id,created_at desc);
create index friend_challenges_sender on public.friend_challenges(sender_id,created_at desc);
alter table public.player_follows enable row level security;
alter table public.player_presence enable row level security;
alter table public.friend_challenges enable row level security;
revoke all on public.player_follows,public.player_presence,public.friend_challenges from anon,authenticated;
grant select on public.player_follows,public.friend_challenges to authenticated;
create policy follows_read on public.player_follows for select to authenticated using(true);
create policy challenges_participant on public.friend_challenges for select to authenticated using(auth.uid() in (sender_id,recipient_id));

create function public.social_verified() returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();
begin
 if uid is null or not exists(select 1 from auth.users where id=uid and email_confirmed_at is not null) then raise exception 'Verified account required'; end if;
 return uid;
end $$;
create function public.social_friends(a uuid,b uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.player_follows where follower_id=a and following_id=b)
 and exists(select 1 from public.player_follows where follower_id=b and following_id=a);
$$;
create function public.social_available(p_player uuid) returns boolean language sql volatile security definer set search_path='' as $$
 select exists(select 1 from public.player_presence where player_id=p_player and available and last_seen>clock_timestamp()-interval '35 seconds')
 and not exists(select 1 from public.ranked_players where player_id=p_player and released_at is null)
 and not exists(select 1 from public.ranked_queue where player_id=p_player and last_seen>clock_timestamp()-interval '25 seconds');
$$;
create function public.social_heartbeat(p_session uuid,p_available boolean default true) returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.social_verified();
begin
 if p_session is null or p_available is null then raise exception 'Invalid presence'; end if;
 delete from public.player_presence where player_id=uid and last_seen<clock_timestamp()-interval '2 minutes';
 insert into public.player_presence(player_id,session_id,available) values(uid,p_session,p_available)
 on conflict(player_id,session_id) do update set last_seen=clock_timestamp(),available=excluded.available;
end $$;
create function public.social_follow(p_player uuid,p_follow boolean) returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.social_verified();
begin
 if uid=p_player or p_follow is null then raise exception 'Invalid follow'; end if;
 perform pg_advisory_xact_lock(214734601);
 if p_follow then
  insert into public.player_follows(follower_id,following_id) values(uid,p_player) on conflict do nothing;
 else
  delete from public.player_follows where follower_id=uid and following_id=p_player;
  update public.friend_challenges set status='cancelled' where status='pending' and
   ((sender_id=uid and recipient_id=p_player) or (recipient_id=uid and sender_id=p_player));
 end if;
end $$;
create function public.social_set_display_name(p_name text) returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.social_verified();
begin
 if char_length(trim(p_name))>60 then raise exception 'Use at most 60 characters'; end if;
 update public.profiles set display_name=nullif(trim(p_name),'') where id=uid;
end $$;
-- Explicit public allowlist; no emails, auth metadata or presence session identifiers.
create function public.social_profile(p_player uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p.id,'username',p.username,'display_name',p.display_name,'elo',p.elo,
 'wins',p.wins,'losses',p.losses,'draws',p.draws,'matches_played',p.wins+p.losses+p.draws,
 'followers',(select count(*) from public.player_follows where following_id=p.id),
 'following',(select count(*) from public.player_follows where follower_id=p.id),
 'friends',(select count(*) from public.player_follows f where f.follower_id=p.id and public.social_friends(p.id,f.following_id)),
 'is_following',exists(select 1 from public.player_follows where follower_id=auth.uid() and following_id=p.id),
 'follows_you',exists(select 1 from public.player_follows where follower_id=p.id and following_id=auth.uid()),
 'is_friend',public.social_friends(auth.uid(),p.id),
 'available',case when p.id=auth.uid() or public.social_friends(auth.uid(),p.id) then public.social_available(p.id) else false end)
 from public.profiles p where p.id=p_player;
$$;
create function public.social_players(p_view text default 'friends',p_query text default '',p_player uuid default null,p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare target uuid:=coalesce(p_player,auth.uid()); result jsonb;
begin
 if p_view not in ('search','friends','followers','following') or p_offset<0 then raise exception 'Invalid player view'; end if;
 select coalesce(jsonb_agg(public.social_profile(x.id) order by x.username,x.id),'[]'::jsonb) into result from (
  select p.id,p.username from public.profiles p where
  case p_view
   when 'search' then length(trim(p_query))>=2 and starts_with(lower(p.username),lower(trim(p_query)))
   when 'friends' then public.social_friends(target,p.id)
   when 'followers' then exists(select 1 from public.player_follows where follower_id=p.id and following_id=target)
   when 'following' then exists(select 1 from public.player_follows where follower_id=target and following_id=p.id)
  end order by p.username,p.id limit 30 offset p_offset
 ) x;
 return result;
end $$;
create function public.social_send_challenge(p_player uuid,p_mode text default 'typing') returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.social_verified(); cid uuid;
begin
 if p_mode is null or p_mode not in ('voice','typing') or uid=p_player then raise exception 'Invalid challenge'; end if;
 perform pg_advisory_xact_lock(214734601);
 update public.friend_challenges set status='expired' where status='pending' and expires_at<=clock_timestamp();
 if not public.social_friends(uid,p_player) then raise exception 'Follow each other to become friends first'; end if;
 if not public.social_available(uid) or not public.social_available(p_player) then raise exception 'Both friends must be online and available'; end if;
 if exists(select 1 from public.friend_challenges where status='pending' and (sender_id in (uid,p_player) or recipient_id in (uid,p_player))) then raise exception 'A player already has a pending invitation'; end if;
 insert into public.friend_challenges(sender_id,recipient_id,sender_mode) values(uid,p_player,p_mode) returning id into cid;
 return cid;
end $$;
create function public.social_respond_challenge(p_challenge uuid,p_action text,p_mode text default 'typing') returns uuid
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
 start_at+interval '5 seconds'+case when (case when p.id=c.sender_id then c.sender_mode else p_mode end)='voice' then interval '15 seconds' else interval '20 seconds' end
 from public.profiles p where p.id in (c.sender_id,c.recipient_id);
 insert into public.ranked_drafts(match_id,player_id) values(mid,c.sender_id),(mid,c.recipient_id);
 delete from public.ranked_queue where player_id in (c.sender_id,c.recipient_id);
 update public.friend_challenges set status='accepted',match_id=mid where id=c.id;
 update public.friend_challenges set status='cancelled' where status='pending' and (sender_id in (c.sender_id,c.recipient_id) or recipient_id in (c.sender_id,c.recipient_id));
 return mid;
end $$;
create function public.social_invitations() returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.social_verified(); result jsonb;
begin
 -- Materialized expiry is lazy; all mutation paths also enforce expires_at, even without a connected client.
 update public.friend_challenges set status='expired' where status='pending' and expires_at<=clock_timestamp() and uid in (sender_id,recipient_id);
 select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb) into result from (
 select c.*,s.username sender_name,r.username recipient_name from public.friend_challenges c
 join public.profiles s on s.id=c.sender_id join public.profiles r on r.id=c.recipient_id
 where uid in (c.sender_id,c.recipient_id) order by c.created_at desc limit 30) x;
 return jsonb_build_object('server_now',clock_timestamp(),'invitations',result);
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
    'answer_text',case when reveal or p.player_id=uid then d.answer_text else null end)) into players
    from public.ranked_players p join public.ranked_drafts d using(match_id,player_id) join public.profiles pr on pr.id=p.player_id where p.match_id=mid;
  return jsonb_build_object('server_now',clock_timestamp(),'queue',null,'match',jsonb_build_object(
    'id',m.id,'player1_id',m.player1_id,'player2_id',m.player2_id,'question',m.question,'state',m.ranked_state,
    'is_ranked',m.is_ranked,'round_start',m.round_start,'completed_at',m.completed_at,'players',players,'judge_error',m.judge_error,
    'judge_retry_at',m.judge_retry_at,'judge_attempts',m.judge_attempts,'result',m.judge_result));
end $$;


create or replace function public.ranked_history() returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x.completed_at desc),'[]'::jsonb) from (
    select m.is_ranked,m.id,m.question,m.player1_id,m.player2_id,m.completed_at,m.judge_result,
      (select jsonb_agg(to_jsonb(p)||jsonb_build_object('answer_text',d.answer_text)) from public.ranked_players p join public.ranked_drafts d using(match_id,player_id) where p.match_id=m.id) as players
    from public.matches m join public.ranked_players own on own.match_id=m.id
    where own.player_id=auth.uid() and m.ranked_state='complete' order by m.completed_at desc limit 100
  ) x;
$$;


create or replace function public.ranked_finalize(p_match uuid,p_token uuid,p_scores1 jsonb,p_scores2 jsonb,p_model text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.matches%rowtype; a public.profiles%rowtype; b public.profiles%rowtype;
  s jsonb; cat text; v numeric; t1 numeric:=0; t2 numeric:=0; actual numeric; d1 integer; d2 integer;
  winner text; winner_uid uuid; decisive text:='Balanced'; gap numeric:=-1; result jsonb;
begin
  select * into m from public.matches where id=p_match for update;
  if m.ranked_state='complete' then return m.judge_result; end if;
  if m.ranked_state<>'judging' or m.judge_token is distinct from p_token then raise exception 'Invalid judging claim'; end if;
  if exists(select 1 from public.ranked_players where match_id=p_match and locked_at is null) then raise exception 'Answers are not locked'; end if;
  foreach s in array array[p_scores1,p_scores2] loop
    if jsonb_typeof(s) is distinct from 'object' or (select count(*) from jsonb_object_keys(s))<>5 then raise exception 'Invalid scores'; end if;
    foreach cat in array array['Logic','Creativity','Relevance','Clarity','Depth'] loop
      if jsonb_typeof(s->cat) is distinct from 'number' then raise exception 'Invalid score type'; end if;
      v := (s->>cat)::numeric;
      if v<0 or v>10 or v<>trunc(v) then raise exception 'Score must be an integer from 0 to 10'; end if;
    end loop;
  end loop;
  foreach cat in array array['Logic','Creativity','Relevance','Clarity','Depth'] loop
    t1:=t1+(p_scores1->>cat)::numeric; t2:=t2+(p_scores2->>cat)::numeric;
    v:=abs((p_scores1->>cat)::numeric-(p_scores2->>cat)::numeric);
    if v>gap then gap:=v; decisive:=cat; end if;
  end loop;
  if t1=t2 then winner:='draw'; actual:=0.5; decisive:='Balanced';
  elsif t1>t2 then winner:='player1'; winner_uid:=m.player1_id; actual:=1;
  else winner:='player2'; winner_uid:=m.player2_id; actual:=0; end if;
  -- Fixed lock order also prevents deadlocks with other server transactions.
  perform 1 from public.profiles where id in (m.player1_id,m.player2_id) order by id for update;
  select * into strict a from public.profiles where id=m.player1_id;
  select * into strict b from public.profiles where id=m.player2_id;
  if m.is_ranked then
  d1:=greatest(-a.elo,round(32*(actual-1/(1+power(10::numeric,(b.elo-a.elo)/400::numeric))))::integer);
  d2:=greatest(-b.elo,round(32*((1-actual)-1/(1+power(10::numeric,(a.elo-b.elo)/400::numeric))))::integer);
  update public.profiles set elo=a.elo+d1,wins=a.wins+(actual=1)::integer,losses=a.losses+(actual=0)::integer,draws=a.draws+(actual=0.5)::integer where id=a.id;
  update public.profiles set elo=b.elo+d2,wins=b.wins+(actual=0)::integer,losses=b.losses+(actual=1)::integer,draws=b.draws+(actual=0.5)::integer where id=b.id;
  else
    d1:=0; d2:=0;
  end if;
  update public.ranked_players set scores=p_scores1,total=t1,elo_before=a.elo,elo_after=a.elo+d1,delta=d1 where match_id=p_match and player_id=a.id;
  update public.ranked_players set scores=p_scores2,total=t2,elo_before=b.elo,elo_after=b.elo+d2,delta=d2 where match_id=p_match and player_id=b.id;
  result:=jsonb_build_object('model',p_model,'player1',jsonb_build_object('scores',p_scores1,'total',t1),
    'player2',jsonb_build_object('scores',p_scores2,'total',t2),'winner',winner,'decisiveCategory',decisive);
  update public.matches set ranked_state='complete',status='completed',winner_id=winner_uid,completed_at=clock_timestamp(),judge_result=result,judge_lease_until=null,judge_error=null where id=p_match;
  return result;
end $$;

-- New functions are private unless explicitly listed below.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'social_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 end loop;
end $$;
grant execute on function public.social_profile(uuid),public.social_players(text,text,uuid,integer) to anon,authenticated;
grant execute on function public.social_follow(uuid,boolean),public.social_set_display_name(text),public.social_heartbeat(uuid,boolean),public.social_send_challenge(uuid,text),public.social_respond_challenge(uuid,text,text),public.social_invitations() to authenticated;
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
 alter publication supabase_realtime add table public.friend_challenges,public.player_follows;
 end if;
end $$;
commit;
