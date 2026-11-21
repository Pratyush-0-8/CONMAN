-- One-time operator setup. Does not alter or retire available stock.
begin;
create table public.qgen_rollout_stage (
 id bigint generated always as identity primary key,
 catalog_id bigint not null unique references public.question_catalog(id),
 generation_run_id uuid not null references public.question_generation_runs(id)
);
alter table public.qgen_rollout_stage enable row level security;
revoke all on public.qgen_rollout_stage from public,anon,authenticated;
create or replace function public.qgen_rollout_commit(p_run uuid,p_token uuid,p_request uuid,p_questions jsonb) returns integer
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
  if r.job<>'arena_rotate' then raise exception 'Rollout stages ten-question batches only'; end if;
  perform public.qgen_validate(p_questions,n);
  if (select count(*) from public.qgen_rollout_stage)+n>200 then raise exception 'Rollout stock already complete'; end if;
  for q in select jsonb_array_elements_text(p_questions) loop
    insert into public.question_catalog(question) values(q) returning id into cid;
    insert into public.qgen_rollout_stage(catalog_id,generation_run_id) values(cid,p_run);
  end loop;
  update public.question_generation_requests set accepted_count=n where id=p_request;
  update public.question_generation_runs set status='success',inserted_count=n,finished_at=clock_timestamp() where id=p_run;
  return n;
end $$;
revoke all on function public.qgen_rollout_commit(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.qgen_rollout_commit(uuid,uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
