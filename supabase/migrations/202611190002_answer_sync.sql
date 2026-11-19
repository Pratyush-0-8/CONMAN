begin;

-- Revision numbers order full replacements. A writer token fences requests from an older tab/refresh.
alter table public.ranked_drafts
  add column revision bigint not null default 0 check(revision between 0 and 9007199254740991),
  add column writer_id uuid;

create function public.ranked_answer_snapshot(p_match uuid,p_player uuid,p_status text) returns jsonb
language sql security definer set search_path='' as $$
 select jsonb_build_object('status',p_status,'answer_text',d.answer_text,'revision',d.revision,
   'writer_id',d.writer_id,'locked_at',p.locked_at,'server_now',clock_timestamp())
 from public.ranked_drafts d join public.ranked_players p using(match_id,player_id)
 where d.match_id=p_match and d.player_id=p_player;
$$;

create function public.ranked_begin_answer(p_match uuid,p_writer uuid,p_previous_writer uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); m public.matches%rowtype; p public.ranked_players%rowtype; d public.ranked_drafts%rowtype;
begin
 if uid is null then raise exception 'Sign in required'; end if;
 if p_writer is null then raise exception 'Editor token required'; end if;
 select * into m from public.matches where id=p_match for update;
 select * into p from public.ranked_players where match_id=p_match and player_id=uid;
 if p.player_id is null then raise exception 'Not a participant'; end if;
 perform public.ranked_tick(p_match);
 select * into p from public.ranked_players where match_id=p_match and player_id=uid;
 if p.locked_at is not null or m.ranked_state<>'active' then
  return public.ranked_answer_snapshot(p_match,uid,'locked');
 end if;
 select * into strict d from public.ranked_drafts where match_id=p_match and player_id=uid;
 if d.writer_id is distinct from p_writer then
  -- Compare-and-swap makes delayed/retried acquisition unable to steal a newer editor.
  if d.writer_id is distinct from p_previous_writer then
   return public.ranked_answer_snapshot(p_match,uid,'superseded');
  end if;
  update public.ranked_drafts set writer_id=p_writer where match_id=p_match and player_id=uid;
 end if;
 return public.ranked_answer_snapshot(p_match,uid,'ready');
end $$;

create function public.ranked_answer_v2(p_match uuid,p_text text,p_final boolean,p_revision bigint,p_writer uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); m public.matches%rowtype; p public.ranked_players%rowtype; d public.ranked_drafts%rowtype;
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
 if clock_timestamp()<m.round_start+interval '5 seconds' then raise exception 'Thinking period is not over'; end if;
 -- Keep the existing input deadlines and bounded transport grace. Late drafts cannot extend the round.
 if clock_timestamp()>p.deadline and not (p_final and clock_timestamp()<=p.deadline+
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

-- Old browser builds cannot safely order replacements; require a reload rather than accept unversioned writes.
-- Keeping the signature gives existing tabs a useful error during the backend/frontend rollout.
create or replace function public.ranked_answer(p_match uuid,p_text text,p_final boolean default false) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 if not exists(select 1 from public.ranked_players where match_id=p_match and player_id=auth.uid()) then raise exception 'Not a participant'; end if;
 raise exception 'Reload Arena to use editable, versioned answer synchronization';
end $$;

revoke all on function public.ranked_answer_snapshot(uuid,uuid,text),public.ranked_begin_answer(uuid,uuid,uuid),
 public.ranked_answer_v2(uuid,text,boolean,bigint,uuid) from public,anon,authenticated;
grant execute on function public.ranked_begin_answer(uuid,uuid,uuid),public.ranked_answer_v2(uuid,text,boolean,bigint,uuid) to authenticated;

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
    'is_ranked',m.is_ranked,'round_start',m.round_start,'completed_at',m.completed_at,'players',players,'judge_error',m.judge_error,
    'judge_retry_at',m.judge_retry_at,'judge_attempts',m.judge_attempts,'result',m.judge_result));
end $$;

commit;
