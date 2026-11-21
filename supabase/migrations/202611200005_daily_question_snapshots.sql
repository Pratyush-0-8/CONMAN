begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- Pin question assignments so an authorized pool replacement cannot reinterpret old answers.
alter table public.daily_attempts add column question_snapshot jsonb
 check(question_snapshot is null or (jsonb_typeof(question_snapshot)='array' and jsonb_array_length(question_snapshot)=5));
update public.daily_attempts a set question_snapshot=(select jsonb_agg(q.question order by q.position)
 from public.daily_questions q where q.challenge_date=a.challenge_date)
 where (select count(*) from public.daily_questions q where q.challenge_date=a.challenge_date)=5;
create function public.daily_pin_questions() returns trigger language plpgsql security definer set search_path='' as $$
begin
 select jsonb_agg(question order by position) into new.question_snapshot
 from public.daily_questions where challenge_date=new.challenge_date;
 return new;
end $$;
create trigger daily_pin_questions before insert on public.daily_attempts
 for each row execute function public.daily_pin_questions();
revoke all on function public.daily_pin_questions() from public,anon,authenticated;

create or replace function public.daily_state(p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype; rounds jsonb;
begin
  select * into a from public.daily_attempts where token_hash=p_hash for update;
  if a.id is null then raise exception 'Invalid attempt token' using errcode='42501'; end if;
  perform public.daily_tick(a.id);
  select jsonb_agg(jsonb_build_object('position',q.position,'question',case when r.started_at is not null then coalesce(a.question_snapshot->>(q.position-1),q.question) else null end,
    'thinking_seconds',a.thinking_seconds,'answer_seconds',case when a.input_mode='voice' then a.voice_seconds else a.typing_seconds end,
    'answer_revision',r.revision,'answer_writer',r.writer_id,'locked_at',r.locked_at,'final_answer_text',r.final_answer_text,
    'started_at',r.started_at,'deadline',r.deadline,'answer_text',r.answer_text,'state',r.state,'scores',r.scores,'total',r.total,
    'explanation',r.explanation,'judge_error',r.judge_error,'retry_at',r.retry_at,'judge_lease_until',r.judge_lease_until,'judge_attempts',r.judge_attempts) order by q.position) into rounds
    from public.daily_questions q left join public.daily_answers r on r.attempt_id=a.id and r.position=q.position where q.challenge_date=a.challenge_date;
  return jsonb_build_object('server_now',clock_timestamp(),'id',a.id,'date',a.challenge_date,'mode',a.input_mode,
    'position',a.current_position,'status',a.status,'final_score',a.final_score,'rounds',rounds);
end $$;

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
  return jsonb_build_object('token',token,'question',(select coalesce(a.question_snapshot->>(p_position-1),question) from public.daily_questions where challenge_date=a.challenge_date and position=p_position),'answer',r.final_answer_text,'answer_confirmed',true,'answer_revision',r.final_revision);
end $$;

notify pgrst,'reload schema';
commit;
