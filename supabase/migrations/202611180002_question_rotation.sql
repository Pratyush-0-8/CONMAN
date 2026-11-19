-- Forward-only update to the already-applied question generation migration.
-- Keep function identities/permissions, question IDs, matches, FIFO, leases and budgets.
-- No inventory is retired by applying this migration. A successful batch alone
-- archives the eligible excess atomically (also handles a legacy pool above 150).
begin;

create or replace function public.qgen_claim(p_job text,p_force boolean default false,p_fill boolean default false) returns jsonb
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
  if p_job='arena_rotate' and not p_fill then update public.question_generation_jobs set next_due_at=to_timestamp((floor(extract(epoch from now_at)/21600)+1)*21600) where job=p_job; end if;
  if p_job='daily_refill' then
    select count(*) into n from public.daily_question_queue where consumed_date is null;
    if not j.refill_open then update public.question_generation_jobs set next_due_at=now_at+interval '10 hours',cycle_started_at=now_at,refill_open=true where job=p_job; end if;
    if n>=35 then
      update public.question_generation_jobs set refill_open=false,last_completed_at=now_at,last_error=null,retry_after=null where job=p_job;
      return jsonb_build_object('skip','reserve full','unused',n);
    end if;
  end if;
  if p_job='arena_rotate' and p_fill and (select count(*) from public.ranked_questions)>=150 then return jsonb_build_object('skip','Arena pool full'); end if;
  token:=gen_random_uuid();
  update public.question_generation_runs set status='interrupted',finished_at=now_at,error='Worker lease expired' where job=p_job and status='running';
  update public.question_generation_jobs set lease_token=token,lease_until=now_at+interval '4 minutes' where job=p_job;
  insert into public.question_generation_runs(job,claim_token) values(p_job,token) returning id into run;
  return jsonb_build_object('run_id',run,'token',token);
end $$;

create or replace function public.qgen_commit_batch(p_run uuid,p_token uuid,p_request uuid,p_questions jsonb) returns integer
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
    excess:=greatest(0,(select count(*)::integer from public.ranked_questions)+10-150);
    select array_agg(id) into victims from (
      select b.id from public.ranked_question_bank b where retired_at is null and not exists(
        select 1 from public.matches m where m.question=b.question and m.ranked_state is distinct from 'complete' and m.status is distinct from 'completed')
      order by b.created_at,b.id limit excess
    ) eligible;
    if coalesce(cardinality(victims),0)<excess then raise exception 'Not enough eligible Arena questions to rotate safely; pool unchanged'; end if;
    -- No retirement occurs until this batch reaches/exceeds the 150-question target.
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

-- Move the due gate to the next six-hour UTC boundary, retaining leases/cooldowns.
update public.question_generation_jobs
set next_due_at=to_timestamp((floor(extract(epoch from clock_timestamp())/21600)+1)*21600)
where job='arena_rotate';

-- If the existing opt-in Cron job is installed, update its timing in place.
-- Never create or enable schedules here. Guard its command before altering it.
do $$
declare existing record;
begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    for existing in execute $sql$select jobid,command from cron.job where jobname='conman-arena-rotate'$sql$ loop
      if trim(existing.command)<>$command$select public.qgen_cron_invoke('arena_rotate');$command$ then
        raise exception 'Unexpected Arena Cron command; inspect it before migrating';
      end if;
      execute format('select cron.alter_job(%s,schedule:=%L)',existing.jobid,'0 */6 * * *');
    end loop;
  end if;
end $$;
notify pgrst,'reload schema';
commit;
