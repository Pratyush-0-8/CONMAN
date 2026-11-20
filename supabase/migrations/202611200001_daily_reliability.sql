begin;
alter table public.daily_answers
 add column revision bigint not null default 0 check(revision between 0 and 9007199254740991),
 add column writer_id uuid,
 add column final_answer_text text,
 add column final_revision bigint;

-- Freeze the exact persisted answer in the transaction that locks it. No historical backfill.
create function public.daily_answer_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if old.state<>'active' and (new.answer_text is distinct from old.answer_text or new.revision is distinct from old.revision) then
  raise exception 'Locked answers are immutable';
 end if;
 if old.final_answer_text is not null and (new.final_answer_text is distinct from old.final_answer_text or new.final_revision is distinct from old.final_revision) then
  raise exception 'Confirmed final answers are immutable';
 end if;
 if old.state='active' and new.state<>'active' then
  new.final_answer_text:=new.answer_text; new.final_revision:=new.revision;
 end if;
 return new;
end $$;
create trigger daily_answer_guard before update on public.daily_answers for each row execute function public.daily_answer_guard();

create function public.daily_answer_snapshot(p_id uuid,p_position integer,p_status text) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('status',p_status,'answer_text',answer_text,'revision',revision,'writer_id',writer_id,
 'locked_at',locked_at,'final_answer_text',final_answer_text,'final_revision',final_revision,'server_now',clock_timestamp())
 from public.daily_answers where attempt_id=p_id and position=p_position;
$$;
create function public.daily_begin_answer(p_hash text,p_position integer,p_writer uuid,p_previous_writer uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype; r public.daily_answers%rowtype;
begin
 select * into a from public.daily_attempts where token_hash=p_hash for update;
 if a.id is null then raise exception 'Invalid attempt token' using errcode='42501'; end if;
 if p_position is distinct from a.current_position then raise exception 'Not the current question'; end if;
 if p_writer is null then raise exception 'Editor token required'; end if;
 perform public.daily_tick(a.id);
 select * into strict r from public.daily_answers where attempt_id=a.id and position=p_position;
 if r.state<>'active' then return public.daily_answer_snapshot(a.id,p_position,'locked'); end if;
 if r.writer_id is distinct from p_writer then
  if r.writer_id is distinct from p_previous_writer then return public.daily_answer_snapshot(a.id,p_position,'superseded'); end if;
  update public.daily_answers set writer_id=p_writer where attempt_id=a.id and position=p_position;
 end if;
 return public.daily_answer_snapshot(a.id,p_position,'ready');
end $$;
create function public.daily_answer_v2(p_hash text,p_position integer,p_text text,p_final boolean,p_revision bigint,p_writer uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype; r public.daily_answers%rowtype;
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
 if clock_timestamp()<r.started_at+interval '5 seconds' then raise exception 'Thinking period is not over'; end if;
 if clock_timestamp()>r.deadline and not(p_final and clock_timestamp()<=r.deadline+
 case when a.input_mode='voice' then interval '1500 milliseconds' else interval '500 milliseconds' end) then
  perform public.daily_tick(a.id); return public.daily_answer_snapshot(a.id,p_position,'expired');
 end if;
 update public.daily_answers set answer_text=p_text,revision=p_revision,state=case when p_final then 'locked' else 'active' end,
 locked_at=case when p_final then clock_timestamp() else null end where attempt_id=a.id and position=p_position;
 return public.daily_answer_snapshot(a.id,p_position,case when p_final then 'locked' else 'saved' end);
end $$;
create or replace function public.daily_answer(p_hash text,p_position integer,p_text text,p_final boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.daily_attempts where token_hash=p_hash) then raise exception 'Invalid attempt token' using errcode='42501'; end if;
 raise exception 'Reload Daily Five to use editable, versioned answer synchronization';
end $$;
create or replace function public.daily_state(p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype; rounds jsonb;
begin
  select * into a from public.daily_attempts where token_hash=p_hash for update;
  if a.id is null then raise exception 'Invalid attempt token' using errcode='42501'; end if;
  perform public.daily_tick(a.id);
  select jsonb_agg(jsonb_build_object('position',q.position,'question',case when r.started_at is not null then q.question else null end,
    'answer_revision',r.revision,'answer_writer',r.writer_id,'locked_at',r.locked_at,'final_answer_text',r.final_answer_text,
    'started_at',r.started_at,'deadline',r.deadline,'answer_text',r.answer_text,'state',r.state,'scores',r.scores,'total',r.total,
    'explanation',r.explanation,'judge_error',r.judge_error,'retry_at',r.retry_at,'judge_lease_until',r.judge_lease_until,'judge_attempts',r.judge_attempts) order by q.position) into rounds
    from public.daily_questions q left join public.daily_answers r on r.attempt_id=a.id and r.position=q.position where q.challenge_date=a.challenge_date;
  return jsonb_build_object('server_now',clock_timestamp(),'id',a.id,'date',a.challenge_date,'mode',a.input_mode,
    'position',a.current_position,'status',a.status,'final_score',a.final_score,'rounds',rounds);
end $$;
create or replace function public.daily_today() returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('date',d,'available',exists(select 1 from public.daily_challenges where challenge_date=d and published),'server_now',clock_timestamp(),'next_date_at',((d+1)::timestamp at time zone 'America/New_York'))
    from (select (clock_timestamp() at time zone 'America/New_York')::date d) t;
$$;
create or replace function public.daily_claim(p_hash text,p_position integer,p_abuse_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype; r public.daily_answers%rowtype; token uuid;
begin
  select * into a from public.daily_attempts where token_hash=p_hash for update;
  if a.id is null then raise exception 'Invalid attempt token' using errcode='42501'; end if;
  if p_position<>a.current_position then raise exception 'Not the current question'; end if;
  perform public.daily_tick(a.id);
  select * into r from public.daily_answers where attempt_id=a.id and position=p_position;
  if r.state='graded' then return jsonb_build_object('complete',true); end if;
  if r.state='active' or (r.state='judging' and r.judge_lease_until>clock_timestamp()) or (r.state='error' and r.retry_at>clock_timestamp()) then return jsonb_build_object('busy',true); end if;
  -- Legacy locked, ungraded rows get a snapshot only when explicitly claimed; graded history stays untouched.
  if r.final_answer_text is null then
    update public.daily_answers set final_answer_text=answer_text,final_revision=revision where attempt_id=a.id and position=p_position;
    select * into r from public.daily_answers where attempt_id=a.id and position=p_position;
  end if;
  if r.locked_at is null or r.final_answer_text is distinct from r.answer_text or r.final_revision is distinct from r.revision then
    raise exception 'Answer persistence could not be confirmed; retry submission before grading';
  end if;
  if r.judge_attempts>=3 then raise exception 'Judging retry limit reached; no score has been awarded'; end if;
  perform public.daily_take_budget('judge:'||p_abuse_key,50,86400);
  perform public.daily_take_budget('judge:global',1000,86400);
  token:=gen_random_uuid();
  update public.daily_answers set state='judging',judge_token=token,judge_lease_until=clock_timestamp()+interval '90 seconds',
    judge_attempts=judge_attempts+1,judge_error=null,retry_at=null where attempt_id=a.id and position=p_position;
  return jsonb_build_object('token',token,'question',(select question from public.daily_questions where challenge_date=a.challenge_date and position=p_position),'answer',r.final_answer_text,'answer_confirmed',true,'answer_revision',r.final_revision);
end $$;
create or replace function public.daily_finish(p_hash text,p_position integer,p_claim uuid,p_scores jsonb,p_explanation text,p_model text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype; r public.daily_answers%rowtype; cat text; v numeric; score integer:=0; n integer; combined integer;
begin
  select * into a from public.daily_attempts where token_hash=p_hash for update;
  if a.id is null then raise exception 'Invalid attempt token' using errcode='42501'; end if;
  select * into r from public.daily_answers where attempt_id=a.id and position=p_position;
  if r.state='graded' then return public.daily_state(p_hash); end if;
  if r.state is distinct from 'judging' or r.judge_token is distinct from p_claim then raise exception 'Invalid grading claim'; end if;
  if r.final_answer_text is null or r.final_answer_text is distinct from r.answer_text then raise exception 'Answer persistence could not be confirmed'; end if;
  if jsonb_typeof(p_scores) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_scores))<>5 then raise exception 'Invalid category scores'; end if;
  foreach cat in array array['Logic','Creativity','Relevance','Clarity','Depth'] loop
    if jsonb_typeof(p_scores->cat) is distinct from 'number' then raise exception 'Invalid category type'; end if;
    v:=(p_scores->>cat)::numeric;
    if v<0 or v>10 or v<>trunc(v) then raise exception 'Category scores must be integers from 0 to 10'; end if;
    score:=score+v::integer;
  end loop;
  if length(trim(r.answer_text))=0 and score<>0 then raise exception 'An empty answer must score zero'; end if;
  update public.daily_answers set state='graded',scores=p_scores,total=score,explanation=left(coalesce(p_explanation,''),800),model=p_model,judge_lease_until=null,judge_error=null,retry_at=null where attempt_id=a.id and position=p_position;
  select count(*),sum(total) into n,combined from public.daily_answers where attempt_id=a.id and state='graded';
  if n=5 then update public.daily_attempts set status='complete',final_score=combined,completed_at=clock_timestamp() where id=a.id; end if;
  return public.daily_state(p_hash);
end $$;
-- Arena already commits match_answers atomically with answer locking. Judge that record, never a mutable draft.
create function public.ranked_confirmed_answers(p_match uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if (select count(*) from public.ranked_players where match_id=p_match)<>2
 or exists(select 1 from public.ranked_players p left join public.ranked_drafts d using(match_id,player_id)
   where p.match_id=p_match and (p.locked_at is null or d.player_id is null
   or (select count(*) from public.match_answers a where a.match_id=p.match_id and a.player_id=p.player_id)<>1
   or not exists(select 1 from public.match_answers a where a.match_id=p.match_id and a.player_id=p.player_id and a.answer_text=d.answer_text))) then
  raise exception 'Answer persistence could not be confirmed; retry submission before grading';
 end if;
 select jsonb_object_agg(a.player_id,a.answer_text) into result from public.match_answers a
 join public.ranked_players p using(match_id,player_id) where a.match_id=p_match;
 return result;
end $$;

create or replace function public.ranked_claim(p_match uuid,p_requester uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.matches%rowtype; token uuid;
begin
  if not exists(select 1 from public.ranked_players where match_id=p_match and player_id=p_requester) then raise exception 'Not a participant'; end if;
  perform public.ranked_tick(p_match);
  select * into m from public.matches where id=p_match for update;
  if m.ranked_state='complete' then return jsonb_build_object('complete',true,'result',m.judge_result); end if;
  if m.ranked_state='active' or (m.ranked_state='judging' and m.judge_lease_until>clock_timestamp())
     or (m.ranked_state='judge_error' and m.judge_retry_at>clock_timestamp()) then return jsonb_build_object('busy',true); end if;
  perform public.ranked_confirmed_answers(p_match);
  token := gen_random_uuid();
  update public.matches set ranked_state='judging',judge_token=token,judge_lease_until=clock_timestamp()+interval '90 seconds',
    judge_attempts=judge_attempts+1,judge_error=null,judge_retry_at=null where id=p_match;
  return jsonb_build_object('token',token,'question',m.question,'player1_id',m.player1_id,'player2_id',m.player2_id,
    'answers',public.ranked_confirmed_answers(p_match),'answers_confirmed',true);
end $$;
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
  perform public.ranked_confirmed_answers(p_match);
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
revoke all on function public.daily_answer_guard(),public.daily_answer_snapshot(uuid,integer,text),public.daily_begin_answer(text,integer,uuid,uuid),
 public.daily_answer_v2(text,integer,text,boolean,bigint,uuid),public.ranked_confirmed_answers(uuid) from public,anon,authenticated;
grant execute on function public.daily_begin_answer(text,integer,uuid,uuid),public.daily_answer_v2(text,integer,text,boolean,bigint,uuid) to service_role;
notify pgrst,'reload schema';
commit;
