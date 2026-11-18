begin;

create table public.daily_challenges (
  challenge_date date primary key,
  published boolean not null default false,
  created_at timestamptz not null default now()
);
create table public.daily_questions (
  challenge_date date not null references public.daily_challenges(challenge_date),
  position smallint not null check(position between 1 and 5),
  question text not null check(length(trim(question)) between 1 and 2000),
  primary key(challenge_date,position)
);
create table public.daily_attempts (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  challenge_date date not null references public.daily_challenges(challenge_date),
  input_mode text not null check(input_mode in ('voice','typing')),
  current_position smallint not null default 1 check(current_position between 1 and 5),
  status text not null default 'active' check(status in ('active','complete')),
  final_score integer check(final_score between 0 and 250),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  check((status='complete') = (final_score is not null and completed_at is not null))
);
create index daily_population on public.daily_attempts(challenge_date,final_score) where status='complete';
create table public.daily_answers (
  attempt_id uuid not null references public.daily_attempts(id),
  position smallint not null check(position between 1 and 5),
  started_at timestamptz not null,
  deadline timestamptz not null,
  answer_text text not null default '' check(length(answer_text)<=12000),
  state text not null default 'active' check(state in ('active','locked','judging','error','graded')),
  locked_at timestamptz,
  judge_token uuid,
  judge_lease_until timestamptz,
  judge_attempts integer not null default 0 check(judge_attempts between 0 and 3),
  retry_at timestamptz,
  judge_error text,
  scores jsonb,
  total integer check(total between 0 and 50),
  explanation text,
  model text,
  primary key(attempt_id,position),
  check((state='graded') = (scores is not null and total is not null))
);
create table public.daily_rate_buckets (
  bucket_key text not null,
  window_start timestamptz not null,
  hits integer not null,
  expires_at timestamptz not null,
  primary key(bucket_key,window_start)
);

-- Published assignments are immutable and must contain exactly five ordered questions.
create function public.daily_question_guard() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_table_name='daily_challenges' then
    if old.published then raise exception 'Published challenges are immutable'; end if;
  else
    perform 1 from public.daily_challenges where challenge_date=case when tg_op='INSERT' then new.challenge_date else old.challenge_date end for update;
    if exists(select 1 from public.daily_challenges where challenge_date=case when tg_op='INSERT' then new.challenge_date else old.challenge_date end and published)
       or (tg_op='UPDATE' and exists(select 1 from public.daily_challenges where challenge_date=new.challenge_date and published)) then
      raise exception 'Published questions are immutable';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger daily_freeze_challenge before update or delete on public.daily_challenges for each row execute function public.daily_question_guard();
create trigger daily_freeze_questions before insert or update or delete on public.daily_questions for each row execute function public.daily_question_guard();
create function public.daily_check_five() returns trigger language plpgsql set search_path='' as $$
declare d date:=new.challenge_date;
begin
  if exists(select 1 from public.daily_challenges where challenge_date=d and published)
     and (select count(*) from public.daily_questions where challenge_date=d)<>5 then raise exception 'A published challenge requires five questions'; end if;
  return null;
end $$;
create constraint trigger daily_exactly_five after insert or update on public.daily_challenges deferrable initially deferred for each row execute function public.daily_check_five();

alter table public.daily_challenges enable row level security;
alter table public.daily_questions enable row level security;
alter table public.daily_attempts enable row level security;
alter table public.daily_answers enable row level security;
alter table public.daily_rate_buckets enable row level security;
-- No public policies: possession of an anon key or an authenticated account grants no access.
revoke all on public.daily_challenges,public.daily_questions,public.daily_attempts,public.daily_answers,public.daily_rate_buckets from public,anon,authenticated;

create function public.daily_take_budget(p_key text,p_limit integer,p_seconds integer) returns void language plpgsql security definer set search_path='' as $$
declare n integer; w timestamptz;
begin
  w:=case when p_seconds=86400 then date_trunc('day',clock_timestamp() at time zone 'America/New_York') at time zone 'America/New_York'
    else to_timestamp(floor(extract(epoch from clock_timestamp())/p_seconds)*p_seconds) end;
  insert into public.daily_rate_buckets(bucket_key,window_start,hits,expires_at)
    values(p_key,w,1,w+make_interval(secs=>p_seconds)+interval '1 day')
    on conflict(bucket_key,window_start) do update set hits=daily_rate_buckets.hits+1 returning hits into n;
  if n>p_limit then raise exception 'Daily rate limit reached; please retry later' using errcode='P0001'; end if;
end $$;

create function public.daily_today() returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('date',d,'available',exists(select 1 from public.daily_challenges where challenge_date=d and published),'server_now',clock_timestamp())
    from (select (clock_timestamp() at time zone 'America/New_York')::date d) t;
$$;

create function public.daily_tick(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype;
begin
  select * into a from public.daily_attempts where id=p_id for update;
  update public.daily_answers set state='locked',locked_at=clock_timestamp()
    where attempt_id=p_id and position=a.current_position and state='active'
      and deadline+case when a.input_mode='voice' then interval '1500 milliseconds' else interval '500 milliseconds' end<=clock_timestamp();
end $$;

create function public.daily_state(p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype; rounds jsonb;
begin
  select * into a from public.daily_attempts where token_hash=p_hash for update;
  if a.id is null then raise exception 'Invalid attempt token' using errcode='42501'; end if;
  perform public.daily_tick(a.id);
  select jsonb_agg(jsonb_build_object('position',q.position,'question',case when r.started_at is not null then q.question else null end,
    'started_at',r.started_at,'deadline',r.deadline,'answer_text',r.answer_text,'state',r.state,'scores',r.scores,'total',r.total,
    'explanation',r.explanation,'judge_error',r.judge_error,'retry_at',r.retry_at,'judge_lease_until',r.judge_lease_until,'judge_attempts',r.judge_attempts) order by q.position) into rounds
    from public.daily_questions q left join public.daily_answers r on r.attempt_id=a.id and r.position=q.position where q.challenge_date=a.challenge_date;
  return jsonb_build_object('server_now',clock_timestamp(),'id',a.id,'date',a.challenge_date,'mode',a.input_mode,
    'position',a.current_position,'status',a.status,'final_score',a.final_score,'rounds',rounds);
end $$;

create function public.daily_start(p_hash text,p_mode text,p_abuse_key text,p_date date) returns jsonb language plpgsql security definer set search_path='' as $$
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
  insert into public.daily_answers(attempt_id,position,started_at,deadline) values(mid,1,t,t+interval '5 seconds'+case when p_mode='voice' then interval '15 seconds' else interval '20 seconds' end);
  return public.daily_state(p_hash);
end $$;

create function public.daily_answer(p_hash text,p_position integer,p_text text,p_final boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype; r public.daily_answers%rowtype;
begin
  select * into a from public.daily_attempts where token_hash=p_hash for update;
  if a.id is null then raise exception 'Invalid attempt token' using errcode='42501'; end if;
  if p_position<>a.current_position then raise exception 'Not the current question'; end if;
  select * into r from public.daily_answers where attempt_id=a.id and position=p_position;
  if r.state<>'active' then return public.daily_state(p_hash); end if;
  if clock_timestamp()<r.started_at+interval '5 seconds' then raise exception 'Thinking period is not over'; end if;
  if clock_timestamp()>r.deadline and not(p_final and clock_timestamp()<=r.deadline+case when a.input_mode='voice' then interval '1500 milliseconds' else interval '500 milliseconds' end) then
    perform public.daily_tick(a.id); return public.daily_state(p_hash);
  end if;
  if p_text is null or length(p_text)>12000 then raise exception 'Invalid answer length'; end if;
  if a.input_mode='typing' and left(p_text,length(r.answer_text)) is distinct from r.answer_text then raise exception 'Typing answers must be append-only'; end if;
  update public.daily_answers set answer_text=p_text,state=case when p_final then 'locked' else 'active' end,
    locked_at=case when p_final then clock_timestamp() else null end where attempt_id=a.id and position=p_position;
  return public.daily_state(p_hash);
end $$;

create function public.daily_next(p_hash text,p_position integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype; t timestamptz;
begin
  select * into a from public.daily_attempts where token_hash=p_hash for update;
  if a.id is null then raise exception 'Invalid attempt token' using errcode='42501'; end if;
  if p_position<a.current_position or a.status='complete' then return public.daily_state(p_hash); end if;
  if p_position<>a.current_position or p_position>=5 or not exists(select 1 from public.daily_answers where attempt_id=a.id and position=p_position and state='graded') then raise exception 'Finish the current question first'; end if;
  t:=clock_timestamp()+interval '750 milliseconds';
  update public.daily_attempts set current_position=p_position+1 where id=a.id;
  insert into public.daily_answers(attempt_id,position,started_at,deadline) values(a.id,p_position+1,t,t+interval '5 seconds'+case when a.input_mode='voice' then interval '15 seconds' else interval '20 seconds' end);
  return public.daily_state(p_hash);
end $$;

create function public.daily_claim(p_hash text,p_position integer,p_abuse_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype; r public.daily_answers%rowtype; token uuid;
begin
  select * into a from public.daily_attempts where token_hash=p_hash for update;
  if a.id is null then raise exception 'Invalid attempt token' using errcode='42501'; end if;
  if p_position<>a.current_position then raise exception 'Not the current question'; end if;
  perform public.daily_tick(a.id);
  select * into r from public.daily_answers where attempt_id=a.id and position=p_position;
  if r.state='graded' then return jsonb_build_object('complete',true); end if;
  if r.state='active' or (r.state='judging' and r.judge_lease_until>clock_timestamp()) or (r.state='error' and r.retry_at>clock_timestamp()) then return jsonb_build_object('busy',true); end if;
  if r.judge_attempts>=3 then raise exception 'Judging retry limit reached; no score has been awarded'; end if;
  perform public.daily_take_budget('judge:'||p_abuse_key,50,86400);
  perform public.daily_take_budget('judge:global',1000,86400);
  token:=gen_random_uuid();
  update public.daily_answers set state='judging',judge_token=token,judge_lease_until=clock_timestamp()+interval '90 seconds',
    judge_attempts=judge_attempts+1,judge_error=null,retry_at=null where attempt_id=a.id and position=p_position;
  return jsonb_build_object('token',token,'question',(select question from public.daily_questions where challenge_date=a.challenge_date and position=p_position),'answer',r.answer_text);
end $$;

create function public.daily_finish(p_hash text,p_position integer,p_claim uuid,p_scores jsonb,p_explanation text,p_model text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype; r public.daily_answers%rowtype; cat text; v numeric; score integer:=0; n integer; combined integer;
begin
  select * into a from public.daily_attempts where token_hash=p_hash for update;
  if a.id is null then raise exception 'Invalid attempt token' using errcode='42501'; end if;
  select * into r from public.daily_answers where attempt_id=a.id and position=p_position;
  if r.state='graded' then return public.daily_state(p_hash); end if;
  if r.state is distinct from 'judging' or r.judge_token is distinct from p_claim then raise exception 'Invalid grading claim'; end if;
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

create function public.daily_fail(p_hash text,p_position integer,p_claim uuid,p_error text,p_rate_limited boolean default false) returns void
language plpgsql security definer set search_path='' as $$
begin
  update public.daily_answers r set state='error',judge_error=left(p_error,300),retry_at=clock_timestamp()+case when p_rate_limited then interval '60 seconds' else interval '15 seconds' end,judge_lease_until=null
    from public.daily_attempts a where a.id=r.attempt_id and a.token_hash=p_hash and r.position=p_position and r.judge_token=p_claim and r.state='judging';
end $$;

create function public.daily_distribution(p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.daily_attempts%rowtype; n integer; below integer; ties integer; bins jsonb;
begin
  select * into a from public.daily_attempts where token_hash=p_hash and status='complete';
  if a.id is null then raise exception 'Complete your attempt to see the population distribution' using errcode='42501'; end if;
  select count(*),count(*) filter(where final_score<a.final_score),count(*) filter(where final_score=a.final_score)
    into n,below,ties from public.daily_attempts where challenge_date=a.challenge_date and status='complete'
      and (select count(*)=5 and sum(r.total)=daily_attempts.final_score from public.daily_answers r where r.attempt_id=daily_attempts.id and r.state='graded');
  select jsonb_agg(jsonb_build_object('from',i*10,'to',case when i=24 then 250 else i*10+9 end,'count',coalesce(c,0)) order by i) into bins
    from generate_series(0,24) i left join (select least(24,final_score/10) b,count(*) c from public.daily_attempts where challenge_date=a.challenge_date and status='complete'
      and (select count(*)=5 and sum(r.total)=daily_attempts.final_score from public.daily_answers r where r.attempt_id=daily_attempts.id and r.state='graded') group by 1) h on h.b=i;
  return jsonb_build_object('date',a.challenge_date,'count',n,'percentile',round(100*(below+ties/2.0)/greatest(n,1),1),'bins',bins);
end $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'daily_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  end loop;
end $$;
grant execute on function public.daily_today(),public.daily_take_budget(text,integer,integer),public.daily_start(text,text,text,date),public.daily_state(text),public.daily_answer(text,integer,text,boolean),public.daily_next(text,integer),public.daily_claim(text,integer,text),public.daily_finish(text,integer,uuid,jsonb,text,text),public.daily_fail(text,integer,uuid,text,boolean),public.daily_distribution(text) to service_role;
notify pgrst,'reload schema';
commit;
