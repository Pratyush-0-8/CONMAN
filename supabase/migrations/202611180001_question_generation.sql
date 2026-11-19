begin;

create function public.qgen_normalize(p_text text) returns text language sql immutable parallel safe set search_path='' as $$
  select lower(trim(regexp_replace(normalize(p_text,NFKC),'[^[:alnum:]]+',' ','g')));
$$;
create function public.qgen_tokens(p_text text) returns text[] language sql immutable parallel safe set search_path='' as $$
  select coalesce(array_agg(distinct token order by token),'{}'::text[]) from unnest(string_to_array(public.qgen_normalize(p_text),' ')) token
    where length(token)>2 and token<>all(array['the','and','for','that','this','with','would','could','should','why','what','how','does','might','have','from','your','their','every','only','when','which','than','into','about','most','more','less','make','making','being','were','been']);
$$;
create function public.qgen_token_near(a text[],b text[]) returns boolean language sql immutable parallel safe set search_path='' as $$
  with n as(select cardinality(a) na,cardinality(b) nb,(select count(*) from unnest(a) x where x=any(b)) shared)
  select least(na,nb)>=4 and shared>=4 and (2.0*shared/greatest(na+nb,1)>=0.75 or shared::numeric/greatest(least(na,nb),1)>=0.85) from n;
$$;
create function public.qgen_near(p_left text,p_right text) returns boolean language sql immutable parallel safe set search_path='' as $$
  select public.qgen_normalize(p_left)=public.qgen_normalize(p_right) or public.qgen_token_near(public.qgen_tokens(p_left),public.qgen_tokens(p_right));
$$;

create table public.question_catalog (
  id bigint generated always as identity primary key,
  question text not null,
  normalized text generated always as (public.qgen_normalize(question)) stored unique,
  tokens text[] generated always as (public.qgen_tokens(question)) stored,
  created_at timestamptz not null default clock_timestamp()
);
create index question_catalog_tokens on public.question_catalog using gin(tokens);
-- Existing copies/wording are preserved in their original tables. The catalog deduplicates identities only.
insert into public.question_catalog(question)
  select question from (select question from public.ranked_questions union all select question from public.daily_questions) q
  on conflict(normalized) do nothing;

create table public.question_generation_settings (
  singleton boolean primary key default true check(singleton),
  daily_request_limit integer not null default 80 check(daily_request_limit between 1 and 1000),
  quota_exhausted_on date,
  cooldown_until timestamptz
);
insert into public.question_generation_settings(singleton) values(true);
create table public.question_generation_jobs (
  job text primary key check(job in ('daily_refill','daily_publish','arena_rotate')),
  enabled boolean not null default false,
  next_due_at timestamptz not null default clock_timestamp(),
  refill_open boolean not null default false,
  cycle_started_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  retry_after timestamptz,
  last_completed_at timestamptz,
  last_error text
);
insert into public.question_generation_jobs(job) values('daily_refill'),('daily_publish'),('arena_rotate');
create table public.question_generation_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null references public.question_generation_jobs(job),
  claim_token uuid not null,
  model text,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  status text not null default 'running' check(status in ('running','success','error','interrupted')),
  inserted_count integer not null default 0,
  error text,
  details jsonb not null default '{}'
);
create table public.question_generation_requests (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.question_generation_runs(id),
  model text not null,
  requested_count integer not null check(requested_count in (5,10)),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  http_status integer,
  provider_request_id text,
  generated_count integer not null default 0,
  accepted_count integer not null default 0,
  usage jsonb,
  error text
);
create index question_requests_day on public.question_generation_requests(started_at);
create table public.daily_question_queue (
  id bigint generated always as identity primary key,
  catalog_id bigint not null unique references public.question_catalog(id),
  enqueued_at timestamptz not null default clock_timestamp(),
  source text not null check(source in ('manual','generated')),
  generation_run_id uuid references public.question_generation_runs(id),
  consumed_date date references public.daily_challenges(challenge_date),
  consumed_position smallint check(consumed_position between 1 and 5),
  unique(consumed_date,consumed_position),
  check((consumed_date is null)=(consumed_position is null))
);
create index daily_question_fifo on public.daily_question_queue(id) where consumed_date is null;

-- No question is deleted or assigned a new ID. Existing FK references follow this rename.
-- Existing matchmaking continues to read the same relation name and snapshots question text as before.
alter table public.ranked_questions rename to ranked_question_bank;
alter table public.ranked_question_bank
  add column created_at timestamptz not null default now(),
  add column retired_at timestamptz,
  add column catalog_id bigint references public.question_catalog(id),
  add column generation_run_id uuid references public.question_generation_runs(id);
alter table public.ranked_question_bank alter column created_at set default clock_timestamp();
update public.ranked_question_bank b set catalog_id=c.id from public.question_catalog c where c.normalized=public.qgen_normalize(b.question);
create index ranked_question_age on public.ranked_question_bank(created_at,id) where retired_at is null;
create view public.ranked_questions as select id,question from public.ranked_question_bank where retired_at is null with local check option;
revoke all on public.ranked_questions from public,anon,authenticated;

create function public.qgen_sync_history() returns void language sql security definer set search_path='' as $$
  insert into public.question_catalog(question)
    select question from public.daily_questions
    on conflict(normalized) do nothing;
$$;
create function public.qgen_preserve_bank() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'Archive questions instead of deleting them'; end if;
  if tg_op='UPDATE' then
    if new.question is distinct from old.question or new.id is distinct from old.id then raise exception 'Historical questions and IDs are immutable'; end if;
    return new;
  end if;
  perform pg_advisory_xact_lock(37411800);
  insert into public.question_catalog(question) values(new.question) on conflict(normalized) do nothing;
  select id into new.catalog_id from public.question_catalog where normalized=public.qgen_normalize(new.question);
  return new;
end $$;
create trigger qgen_bank_history before insert or update or delete on public.ranked_question_bank for each row execute function public.qgen_preserve_bank();

create function public.qgen_validate(p_questions jsonb,p_count integer) returns void language plpgsql security definer set search_path='' as $$
declare q text; seen text[]:='{}'; candidate text; words integer; norm_text text; content_tokens text[];
begin
  if jsonb_typeof(p_questions) is distinct from 'array' or jsonb_array_length(p_questions)<>p_count then raise exception 'Incorrect question batch size'; end if;
  for q in select value#>>'{}' from jsonb_array_elements(p_questions) e(value) loop
    if q is null or length(q)>250 or q<>trim(regexp_replace(q,'[[:space:]]+',' ','g')) or right(q,1)<>'?' then raise exception 'Invalid question formatting'; end if;
    norm_text:=public.qgen_normalize(q); content_tokens:=public.qgen_tokens(q);
    words:=cardinality(string_to_array(norm_text,' '));
    if words<8 or words>35 then raise exception 'Questions must contain 8–35 words (target 12–25)'; end if;
    foreach candidate in array seen loop
      if public.qgen_near(q,candidate) then raise exception 'Duplicate or similar questions inside batch'; end if;
    end loop;
    if exists(select 1 from public.question_catalog c where c.normalized=norm_text
      or (c.tokens && content_tokens and public.qgen_token_near(c.tokens,content_tokens))) then raise exception 'Duplicate or near-duplicate historical question: %',left(q,150); end if;
    seen:=array_append(seen,q);
  end loop;
  if exists(select 1 from jsonb_array_elements(p_questions) x where jsonb_typeof(x)<>'string') then raise exception 'Questions must be strings'; end if;
end $$;

create function public.qgen_enqueue_manual(p_questions jsonb) returns integer language plpgsql security definer set search_path='' as $$
declare q text; cid bigint; n integer;
begin
  perform pg_advisory_xact_lock(37411800);
  perform public.qgen_sync_history();
  n:=jsonb_array_length(p_questions);
  if n<1 or n>50 then raise exception 'Add between 1 and 50 manual questions'; end if;
  perform public.qgen_validate(p_questions,n);
  for q in select jsonb_array_elements_text(p_questions) loop
    insert into public.question_catalog(question) values(q) returning id into cid;
    insert into public.daily_question_queue(catalog_id,source) values(cid,'manual');
  end loop;
  return n;
end $$;

-- Read-only bounded context, also used by the strictly read-only authenticated dry-run.
create function public.qgen_context() returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('daily_unused',(select count(*) from public.daily_question_queue where consumed_date is null),
    'arena_active',(select count(*) from public.ranked_questions),'daily_request_limit',s.daily_request_limit,
    'requests_today',(select count(*) from public.question_generation_requests where started_at>=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'),
    'quota_exhausted_on',s.quota_exhausted_on,'cooldown_until',s.cooldown_until,
    'history',(select coalesce(jsonb_agg(question),'[]') from (
      (select question from public.question_catalog order by id desc limit 40)
      union (select question from public.daily_questions order by challenge_date desc,position limit 10)
      union (select question from public.ranked_questions order by id limit 10)
    ) q)) from public.question_generation_settings s where singleton;
$$;

create function public.qgen_publication_date(p_now timestamptz) returns date language sql stable set search_path='' as $$
  select d::date+case when d::time>=time '23:30' then 1 else 0 end from (select p_now at time zone 'America/New_York' d) local_time;
$$;

create function public.qgen_claim(p_job text,p_force boolean default false,p_fill boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.question_generation_jobs%rowtype; token uuid; run uuid; n integer; now_at timestamptz:=clock_timestamp();
begin
  select * into j from public.question_generation_jobs where job=p_job for update;
  if j.job is null then raise exception 'Invalid generation job'; end if;
  if not j.enabled then return jsonb_build_object('skip','disabled'); end if;
  if j.lease_until>now_at then return jsonb_build_object('skip','already running'); end if;
  if not p_force and (j.retry_after>now_at or (p_job<>'daily_publish' and not j.refill_open and j.next_due_at>now_at)) then return jsonb_build_object('skip','not due'); end if;
  if p_job='daily_publish' and not p_force and exists(select 1 from public.daily_challenges where challenge_date=public.qgen_publication_date(now_at) and published)
     and (select count(*) from public.daily_questions where challenge_date=public.qgen_publication_date(now_at))=5 then return jsonb_build_object('skip','already published'); end if;
  if p_job='arena_rotate' and not p_fill then update public.question_generation_jobs set next_due_at=to_timestamp((floor(extract(epoch from now_at)/1800)+1)*1800) where job=p_job; end if;
  if p_job='daily_refill' then
    select count(*) into n from public.daily_question_queue where consumed_date is null;
    if not j.refill_open then update public.question_generation_jobs set next_due_at=now_at+interval '10 hours',cycle_started_at=now_at,refill_open=true where job=p_job; end if;
    if n>=35 then
      update public.question_generation_jobs set refill_open=false,last_completed_at=now_at,last_error=null,retry_after=null where job=p_job;
      return jsonb_build_object('skip','reserve full','unused',n);
    end if;
  end if;
  if p_job='arena_rotate' and p_fill and (select count(*) from public.ranked_questions)>=200 then return jsonb_build_object('skip','Arena pool full'); end if;
  token:=gen_random_uuid();
  update public.question_generation_runs set status='interrupted',finished_at=now_at,error='Worker lease expired' where job=p_job and status='running';
  update public.question_generation_jobs set lease_token=token,lease_until=now_at+interval '4 minutes' where job=p_job;
  insert into public.question_generation_runs(job,claim_token) values(p_job,token) returning id into run;
  return jsonb_build_object('run_id',run,'token',token);
end $$;

create function public.qgen_request_begin(p_run uuid,p_token uuid,p_model text,p_count integer) returns uuid
language plpgsql security definer set search_path='' as $$
declare r public.question_generation_runs%rowtype; settings public.question_generation_settings%rowtype; request_id uuid; utc_day date:=(clock_timestamp() at time zone 'UTC')::date;
begin
  -- Serialize account-wide limits across both independently scheduled generators.
  select * into settings from public.question_generation_settings where singleton for update;
  select * into r from public.question_generation_runs where id=p_run for update;
  if r.status is distinct from 'running' or r.claim_token is distinct from p_token or not exists(select 1 from public.question_generation_jobs where job=r.job and enabled and lease_token=p_token and lease_until>clock_timestamp()) then raise exception 'Invalid generation lease'; end if;
  if p_count<>(case when r.job='daily_refill' then 5 else 10 end) or r.job='daily_publish' then raise exception 'Invalid model batch size'; end if;
  if settings.quota_exhausted_on=utc_day or settings.cooldown_until>clock_timestamp() then raise exception 'Cloudflare quota/cooldown active'; end if;
  if (select count(*) from public.question_generation_requests where started_at>=utc_day::timestamp at time zone 'UTC')>=settings.daily_request_limit then raise exception 'Daily Cloudflare request budget exhausted'; end if;
  if (select count(*) from public.question_generation_requests where run_id=p_run)>=3 then raise exception 'Batch retry limit reached'; end if;
  insert into public.question_generation_requests(run_id,model,requested_count) values(p_run,p_model,p_count) returning id into request_id;
  update public.question_generation_runs set model=p_model where id=p_run;
  return request_id;
end $$;

create function public.qgen_request_end(p_request uuid,p_status integer,p_count integer,p_usage jsonb,p_error text,p_provider_id text,p_quota boolean default false,p_cooldown integer default 0) returns void
language plpgsql security definer set search_path='' as $$
begin
  update public.question_generation_requests set finished_at=clock_timestamp(),http_status=p_status,generated_count=p_count,usage=p_usage,error=left(p_error,500),provider_request_id=left(p_provider_id,200) where id=p_request;
  if p_quota or p_cooldown>0 then
    update public.question_generation_settings set quota_exhausted_on=case when p_quota then (clock_timestamp() at time zone 'UTC')::date else quota_exhausted_on end,
      cooldown_until=case when p_cooldown>0 then clock_timestamp()+make_interval(secs=>least(86400,p_cooldown)) else cooldown_until end where singleton;
  end if;
end $$;

create function public.qgen_commit_batch(p_run uuid,p_token uuid,p_request uuid,p_questions jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare r public.question_generation_runs%rowtype; q text; cid bigint; n integer; excess integer; victims bigint[];
begin
  -- Same lock used by existing pairing: a new match cannot select a question being retired.
  perform pg_advisory_xact_lock(214734601);
  perform pg_advisory_xact_lock(37411800);
  select * into r from public.question_generation_runs where id=p_run for update;
  if r.status='success' then return r.inserted_count; end if;
  if r.claim_token is distinct from p_token or r.status is distinct from 'running' or not exists(select 1 from public.question_generation_jobs where job=r.job and enabled and lease_token=p_token and lease_until>clock_timestamp()) then raise exception 'Invalid generation lease'; end if;
  if not exists(select 1 from public.question_generation_requests where id=p_request and run_id=p_run and finished_at is not null and error is null) then raise exception 'Generation request is not validated'; end if;
  perform public.qgen_sync_history();
  n:=case when r.job='daily_refill' then 5 else 10 end;
  perform public.qgen_validate(p_questions,n);
  if r.job='arena_rotate' then
    excess:=greatest(0,(select count(*)::integer from public.ranked_questions)+10-200);
    select array_agg(id) into victims from (
      select b.id from public.ranked_question_bank b where retired_at is null and not exists(
        select 1 from public.matches m where m.question=b.question and m.ranked_state is distinct from 'complete' and m.status is distinct from 'completed')
      order by b.created_at,b.id limit excess
    ) eligible;
    if coalesce(cardinality(victims),0)<excess then raise exception 'Not enough eligible Arena questions to rotate safely; pool unchanged'; end if;
    -- No retirement occurs until this batch reaches/exceeds the 200-question target.
    update public.ranked_question_bank set retired_at=clock_timestamp() where id=any(victims);
  end if;
  for q in select jsonb_array_elements_text(p_questions) loop
    insert into public.question_catalog(question) values(q) returning id into cid;
    if r.job='daily_refill' then insert into public.daily_question_queue(catalog_id,source,generation_run_id) values(cid,'generated',p_run);
    else insert into public.ranked_question_bank(question,catalog_id,generation_run_id) values(q,cid,p_run); end if;
  end loop;
  update public.question_generation_requests set accepted_count=n where id=p_request;
  update public.question_generation_runs set status='success',inserted_count=n,finished_at=clock_timestamp() where id=p_run;
  return n;
end $$;

create function public.qgen_finish_job(p_run uuid,p_token uuid,p_error text default null,p_details jsonb default '{}') returns void
language plpgsql security definer set search_path='' as $$
declare r public.question_generation_runs%rowtype; stock integer;
begin
  select * into r from public.question_generation_runs where id=p_run;
  if r.claim_token is distinct from p_token then raise exception 'Invalid generation lease'; end if;
  select count(*) into stock from public.daily_question_queue where consumed_date is null;
  update public.question_generation_runs set status=case when p_error is null then 'success' else 'error' end,finished_at=clock_timestamp(),error=left(p_error,500),details=p_details where id=p_run and status<>'success';
  update public.question_generation_jobs set lease_token=null,lease_until=null,
    refill_open=case when r.job='daily_refill' then stock<35 else refill_open end,
    last_completed_at=case when p_error is null then clock_timestamp() else last_completed_at end,
    last_error=left(p_error,500),retry_after=case when p_error is not null then clock_timestamp()+interval '15 minutes'
      when r.job='daily_refill' and stock<35 then clock_timestamp()+interval '5 minutes' else null end
    where job=r.job and lease_token=p_token;
end $$;

create function public.qgen_publish(p_run uuid,p_token uuid,p_date date default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.question_generation_runs%rowtype; local_now timestamp:=clock_timestamp() at time zone 'America/New_York'; target date; queue_ids bigint[]; p integer; row record;
begin
  perform pg_advisory_xact_lock(37411800);
  select * into r from public.question_generation_runs where id=p_run for update;
  if r.job is distinct from 'daily_publish' or r.claim_token is distinct from p_token or not exists(select 1 from public.question_generation_jobs where job=r.job and enabled and lease_token=p_token and lease_until>clock_timestamp()) then raise exception 'Invalid publishing lease'; end if;
  target:=coalesce(p_date,public.qgen_publication_date(clock_timestamp()));
  perform 1 from public.daily_challenges where challenge_date=target for update;
  if exists(select 1 from public.daily_challenges where challenge_date=target and published)
    and (select count(*) from public.daily_questions where challenge_date=target)=5 then return jsonb_build_object('date',target,'already_published',true); end if;
  if target<local_now::date or target>local_now::date+1 then raise exception 'Only today/tomorrow may be newly published'; end if;
  select array_agg(id order by id) into queue_ids from (select id from public.daily_question_queue where consumed_date is null order by id limit 5 for update) q;
  if coalesce(cardinality(queue_ids),0)<>5 then raise exception 'Fewer than five FIFO questions; replenish or manually enqueue, then retry publishing'; end if;
  insert into public.daily_challenges(challenge_date) values(target) on conflict do nothing;
  if exists(select 1 from public.daily_questions where challenge_date=target) then raise exception 'Unpublished challenge contains manual questions; finish it manually rather than overwriting'; end if;
  p:=0;
  for row in select q.id,c.question from public.daily_question_queue q join public.question_catalog c on c.id=q.catalog_id where q.id=any(queue_ids) order by q.id loop
    p:=p+1;
    insert into public.daily_questions(challenge_date,position,question) values(target,p,row.question);
    update public.daily_question_queue set consumed_date=target,consumed_position=p where id=row.id;
  end loop;
  update public.daily_challenges set published=true where challenge_date=target;
  return jsonb_build_object('date',target,'published',true,'queue_ids',to_jsonb(queue_ids));
end $$;

-- Default Supabase grants must not expose generation or invocation capabilities.
alter table public.question_catalog enable row level security;
alter table public.daily_question_queue enable row level security;
alter table public.question_generation_settings enable row level security;
alter table public.question_generation_jobs enable row level security;
alter table public.question_generation_runs enable row level security;
alter table public.question_generation_requests enable row level security;
revoke all on public.question_catalog,public.daily_question_queue,public.question_generation_settings,public.question_generation_jobs,public.question_generation_runs,public.question_generation_requests,public.ranked_question_bank from public,anon,authenticated;
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'qgen_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  end loop;
end $$;
grant execute on function public.qgen_context(),public.qgen_claim(text,boolean,boolean),public.qgen_request_begin(uuid,uuid,text,integer),public.qgen_request_end(uuid,integer,integer,jsonb,text,text,boolean,integer),public.qgen_commit_batch(uuid,uuid,uuid,jsonb),public.qgen_finish_job(uuid,uuid,text,jsonb),public.qgen_publish(uuid,uuid,date),public.qgen_enqueue_manual(jsonb) to service_role;
notify pgrst,'reload schema';
commit;
