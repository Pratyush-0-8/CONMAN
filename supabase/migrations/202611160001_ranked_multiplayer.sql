begin;

-- Additive to the existing profiles/matches/match_answers schema. Legacy rows stay intact.
alter table public.profiles add column if not exists draws integer not null default 0;
alter table public.profiles alter column elo set default 500;
alter table public.matches
  add column if not exists ranked_state text,
  add column if not exists round_start timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists judge_token uuid,
  add column if not exists judge_lease_until timestamptz,
  add column if not exists judge_attempts integer not null default 0,
  add column if not exists judge_error text,
  add column if not exists judge_retry_at timestamptz,
  add column if not exists judge_result jsonb;

create table public.ranked_questions (
  id bigint generated always as identity primary key,
  question text not null unique
);
insert into public.ranked_questions(question) values
('Why might bringing shampoo to a job interview be a good idea?'),
('You can only keep one season forever. Which one would help a city thrive most, and why?'),
('A library decides to charge people for returning books early. What problem could that possibly solve?'),
('Why would a restaurant intentionally remove all of its clocks?'),
('What is the strongest argument for making every meeting standing-room only?'),
('If birds could send invoices, what would they bill humans for first?') on conflict do nothing;

create table public.ranked_queue (
  player_id uuid primary key references public.profiles(id) on delete cascade,
  input_mode text not null check (input_mode in ('voice','typing')),
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create table public.ranked_players (
  match_id uuid not null references public.matches(id) on delete cascade,
  player_id uuid not null references public.profiles(id),
  username text not null,
  input_mode text not null check (input_mode in ('voice','typing')),
  deadline timestamptz not null,
  locked_at timestamptz,
  scores jsonb,
  total numeric,
  elo_before integer,
  elo_after integer,
  delta integer,
  released_at timestamptz,
  primary key(match_id,player_id)
);
-- A user can occupy at most one active or unacknowledged ranked match.
create unique index ranked_one_active_player on public.ranked_players(player_id) where released_at is null;
create index ranked_players_history on public.ranked_players(player_id,match_id);
create table public.ranked_drafts (
  match_id uuid not null,
  player_id uuid not null,
  answer_text text not null default '' check (char_length(answer_text) <= 12000),
  primary key(match_id,player_id),
  foreign key(match_id,player_id) references public.ranked_players(match_id,player_id) on delete cascade
);

-- Existing account-creation triggers remain; this enforces the ranked starting stats.
create function public.ranked_initial_stats() returns trigger language plpgsql set search_path = '' as $$
begin new.elo := 500; new.wins := 0; new.losses := 0; new.draws := 0; return new; end $$;
create trigger ranked_initial_stats before insert on public.profiles for each row execute function public.ranked_initial_stats();

alter table public.ranked_queue enable row level security;
alter table public.ranked_players enable row level security;
alter table public.ranked_drafts enable row level security;
alter table public.ranked_questions enable row level security;
alter table public.profiles enable row level security;
alter table public.matches enable row level security;
alter table public.match_answers enable row level security;
-- Realtime notifications contain metadata only. Answers and results are read through ranked_state.
create policy ranked_queue_owner on public.ranked_queue for select to authenticated using (player_id = auth.uid());
create policy ranked_player_owner on public.ranked_players for select to authenticated using (player_id = auth.uid());
-- Restrictive policies also constrain any pre-existing permissive policies.
create policy ranked_matches_privacy on public.matches as restrictive for select to anon, authenticated
  using (ranked_state is null or auth.uid() in (player1_id,player2_id));
create policy ranked_answers_privacy on public.match_answers as restrictive for select to anon, authenticated
  using (exists (select 1 from public.matches m where m.id = match_id and
    (m.ranked_state is null or (auth.uid() in (m.player1_id,m.player2_id) and m.ranked_state in ('judge_pending','judging','judge_error','complete')))));
-- Ranked data is RPC-only. No browser may write ratings, matches, drafts, or answers directly.
revoke all on public.ranked_queue,public.ranked_players,public.ranked_drafts,public.ranked_questions from anon,authenticated;
grant select on public.ranked_queue,public.ranked_players to authenticated;
revoke insert,update,delete,truncate,references,trigger on public.profiles,public.matches,public.match_answers from anon,authenticated;
revoke select on public.profiles from anon,authenticated;
grant select(id,username,elo,wins,losses,draws,created_at) on public.profiles to anon,authenticated;
create policy ranked_profile_read on public.profiles for select to anon,authenticated using (true);

-- Internal helper, called with the match row locked. Deadline expiry locks persisted real text (or empty text).
create function public.ranked_tick(p_match uuid) returns void language plpgsql security definer set search_path = '' as $$
declare m public.matches%rowtype; p record;
begin
  select * into m from public.matches where id=p_match for update;
  if m.ranked_state <> 'active' then return; end if;
  for p in select * from public.ranked_players where match_id=p_match and locked_at is null
    and deadline + case when input_mode='voice' then interval '1500 milliseconds' else interval '500 milliseconds' end <= clock_timestamp()
  loop
    update public.ranked_players set locked_at=clock_timestamp() where match_id=p_match and player_id=p.player_id;
    insert into public.match_answers(match_id,player_id,is_bot,answer_text,submitted_at)
      select p_match,p.player_id,false,d.answer_text,clock_timestamp() from public.ranked_drafts d where d.match_id=p_match and d.player_id=p.player_id;
  end loop;
  if not exists(select 1 from public.ranked_players where match_id=p_match and locked_at is null) then
    update public.matches set ranked_state='judge_pending' where id=p_match;
  end if;
end $$;

create function public.ranked_queue_match(p_mode text default 'voice', p_join boolean default false) returns uuid
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
      start_at+interval '5 seconds'+case when (case when p.id=uid then me.input_mode else other.input_mode end)='voice' then interval '15 seconds' else interval '20 seconds' end
    from public.profiles p where p.id in (uid,other.player_id);
  insert into public.ranked_drafts(match_id,player_id) values(mid,uid),(mid,other.player_id);
  delete from public.ranked_queue where player_id in (uid,other.player_id);
  return mid;
end $$;

create function public.ranked_cancel_queue() returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  perform pg_advisory_xact_lock(214734601);
  delete from public.ranked_queue where player_id=auth.uid();
  -- If pairing already committed it wins the race: clients must restore that active match.
end $$;

create function public.ranked_answer(p_match uuid,p_text text,p_final boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=auth.uid(); m public.matches%rowtype; p public.ranked_players%rowtype; previous text;
begin
  if uid is null then raise exception 'Sign in required'; end if;
  select * into m from public.matches where id=p_match for update;
  select * into p from public.ranked_players where match_id=p_match and player_id=uid;
  if p.player_id is null then raise exception 'Not a participant'; end if;
  if p.locked_at is not null or m.ranked_state<>'active' then return; end if;
  if clock_timestamp()<m.round_start+interval '5 seconds' then raise exception 'Thinking period is not over'; end if;
  -- Final payload delivery grace; the input controls still stop at the saved deadline.
  if clock_timestamp()>p.deadline and not (p_final and clock_timestamp()<=p.deadline+case when p.input_mode='voice' then interval '1500 milliseconds' else interval '500 milliseconds' end) then
    perform public.ranked_tick(p_match); return;
  end if;
  if p_text is null or char_length(p_text)>12000 then raise exception 'Invalid answer length'; end if;
  select answer_text into previous from public.ranked_drafts where match_id=p_match and player_id=uid;
  if p.input_mode='typing' and left(p_text,char_length(previous)) is distinct from previous then raise exception 'Typing answers must be append-only'; end if;
  update public.ranked_drafts set answer_text=p_text where match_id=p_match and player_id=uid;
  if p_final then
    update public.ranked_players set locked_at=clock_timestamp() where match_id=p_match and player_id=uid;
    insert into public.match_answers(match_id,player_id,is_bot,answer_text,submitted_at) values(p_match,uid,false,p_text,clock_timestamp());
  end if;
  perform public.ranked_tick(p_match);
end $$;

create function public.ranked_state(p_match uuid default null) returns jsonb
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
    'round_start',m.round_start,'completed_at',m.completed_at,'players',players,'judge_error',m.judge_error,
    'judge_retry_at',m.judge_retry_at,'judge_attempts',m.judge_attempts,'result',m.judge_result));
end $$;

create function public.ranked_release(p_match uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.ranked_players p set released_at=clock_timestamp() from public.matches m
    where p.match_id=m.id and m.id=p_match and p.player_id=auth.uid() and m.ranked_state='complete' and p.released_at is null;
end $$;

create function public.ranked_history() returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x.completed_at desc),'[]'::jsonb) from (
    select m.id,m.question,m.player1_id,m.player2_id,m.completed_at,m.judge_result,
      (select jsonb_agg(to_jsonb(p)||jsonb_build_object('answer_text',d.answer_text)) from public.ranked_players p join public.ranked_drafts d using(match_id,player_id) where p.match_id=m.id) as players
    from public.matches m join public.ranked_players own on own.match_id=m.id
    where own.player_id=auth.uid() and m.ranked_state='complete' order by m.completed_at desc limit 100
  ) x;
$$;

-- Service-only functions: JWT membership is checked by the Edge Function AND by the claim.
create function public.ranked_claim(p_match uuid,p_requester uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.matches%rowtype; token uuid;
begin
  if not exists(select 1 from public.ranked_players where match_id=p_match and player_id=p_requester) then raise exception 'Not a participant'; end if;
  perform public.ranked_tick(p_match);
  select * into m from public.matches where id=p_match for update;
  if m.ranked_state='complete' then return jsonb_build_object('complete',true,'result',m.judge_result); end if;
  if m.ranked_state='active' or (m.ranked_state='judging' and m.judge_lease_until>clock_timestamp())
     or (m.ranked_state='judge_error' and m.judge_retry_at>clock_timestamp()) then return jsonb_build_object('busy',true); end if;
  token := gen_random_uuid();
  update public.matches set ranked_state='judging',judge_token=token,judge_lease_until=clock_timestamp()+interval '90 seconds',
    judge_attempts=judge_attempts+1,judge_error=null,judge_retry_at=null where id=p_match;
  return jsonb_build_object('token',token,'question',m.question,'player1_id',m.player1_id,'player2_id',m.player2_id,
    'answers',(select jsonb_object_agg(player_id,answer_text) from public.ranked_drafts where match_id=p_match));
end $$;

create function public.ranked_judge_failed(p_match uuid,p_token uuid,p_error text) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.matches set ranked_state='judge_error',judge_error=left(p_error,300),judge_retry_at=clock_timestamp()+interval '15 seconds',judge_lease_until=null
    where id=p_match and judge_token=p_token and ranked_state='judging';
end $$;

create function public.ranked_finalize(p_match uuid,p_token uuid,p_scores1 jsonb,p_scores2 jsonb,p_model text) returns jsonb
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
  d1:=greatest(-a.elo,round(32*(actual-1/(1+power(10::numeric,(b.elo-a.elo)/400::numeric))))::integer);
  d2:=greatest(-b.elo,round(32*((1-actual)-1/(1+power(10::numeric,(a.elo-b.elo)/400::numeric))))::integer);
  update public.profiles set elo=a.elo+d1,wins=a.wins+(actual=1)::integer,losses=a.losses+(actual=0)::integer,draws=a.draws+(actual=0.5)::integer where id=a.id;
  update public.profiles set elo=b.elo+d2,wins=b.wins+(actual=0)::integer,losses=b.losses+(actual=1)::integer,draws=b.draws+(actual=0.5)::integer where id=b.id;
  update public.ranked_players set scores=p_scores1,total=t1,elo_before=a.elo,elo_after=a.elo+d1,delta=d1 where match_id=p_match and player_id=a.id;
  update public.ranked_players set scores=p_scores2,total=t2,elo_before=b.elo,elo_after=b.elo+d2,delta=d2 where match_id=p_match and player_id=b.id;
  result:=jsonb_build_object('model',p_model,'player1',jsonb_build_object('scores',p_scores1,'total',t1),
    'player2',jsonb_build_object('scores',p_scores2,'total',t2),'winner',winner,'decisiveCategory',decisive);
  update public.matches set ranked_state='complete',status='completed',winner_id=winner_uid,completed_at=clock_timestamp(),judge_result=result,judge_lease_until=null,judge_error=null where id=p_match;
  return result;
end $$;

create function public.ranked_leaderboard() returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(r) order by r.rank),'[]'::jsonb) from (
    select id,username,elo,wins,losses,draws,row_number() over(order by elo desc,username,id) as rank from public.profiles
  ) r where r.rank<=100 or r.id=auth.uid();
$$;

-- Explicit allowlist: PostgreSQL grants function execution to PUBLIC by default.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'ranked_%' loop
    execute format('revoke all on function %s from public, anon, authenticated',f.signature);
  end loop;
end $$;
grant execute on function public.ranked_queue_match(text,boolean),public.ranked_cancel_queue(),public.ranked_state(uuid),public.ranked_answer(uuid,text,boolean),public.ranked_release(uuid),public.ranked_history() to authenticated;
grant execute on function public.ranked_leaderboard() to anon,authenticated;
grant execute on function public.ranked_claim(uuid,uuid),public.ranked_judge_failed(uuid,uuid,text),public.ranked_finalize(uuid,uuid,jsonb,jsonb,text) to service_role;

do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.ranked_players, public.ranked_queue;
  end if;
end $$;
commit;
