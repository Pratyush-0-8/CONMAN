-- One-time operator cutover, only after all 131 questions have been staged and reviewed.
-- Existing matches contain their question text; Daily attempts use their pinned snapshots.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(214734601);
select pg_advisory_xact_lock(37411800);
lock table public.daily_attempts,public.daily_questions,public.daily_question_queue,public.ranked_question_bank in access exclusive mode;
create table if not exists public.question_pool_archives (
 kind text not null, identity text not null, row_data jsonb not null,
 retired_at timestamptz not null default clock_timestamp(), primary key(kind,identity)
);
alter table public.question_pool_archives enable row level security;
revoke all on public.question_pool_archives from public,anon,authenticated;
do $$
declare d date:=(clock_timestamp() at time zone 'America/New_York')::date; item record; n integer:=0;
begin
 if (select count(*) from public.qgen_rollout_stage)<>131 then raise exception 'Require all 131 staged questions'; end if;
 if (select count(*) from public.daily_questions where challenge_date=d)<>5 or not exists(select 1 from public.daily_challenges where challenge_date=d and published) then raise exception 'Expected a published five-question Daily challenge'; end if;
 if exists(select 1 from public.daily_attempts where challenge_date=d and question_snapshot is distinct from (select jsonb_agg(question order by position) from public.daily_questions where challenge_date=d)) then raise exception 'An existing Daily attempt is not pinned to its original questions'; end if;
 insert into public.question_pool_archives(kind,identity,row_data)
 select 'daily_published',challenge_date||':'||position,to_jsonb(q) from public.daily_questions q where challenge_date=d;
 insert into public.question_pool_archives(kind,identity,row_data)
 select 'daily_unused',id::text,to_jsonb(q) from public.daily_question_queue q where consumed_date is null;
 insert into public.question_pool_archives(kind,identity,row_data)
 select 'daily_assigned',id::text,to_jsonb(q) from public.daily_question_queue q where consumed_date=d;
 -- Preserve replaced FIFO assignments in the archive before reusing today's unique positions.
 -- No application record references queue IDs; catalog identities and pinned attempts remain intact.
 delete from public.daily_question_queue where consumed_date is null or consumed_date=d;
 -- Only this locked operator transaction bypasses the published-question freeze; re-enable before commit.
 alter table public.daily_questions disable trigger daily_freeze_questions;
 for item in select s.*,c.question from public.qgen_rollout_stage s join public.question_catalog c on c.id=s.catalog_id order by s.id loop
   n:=n+1;
   if n<=25 then
     insert into public.daily_question_queue(catalog_id,source,generation_run_id,consumed_date,consumed_position)
     values(item.catalog_id,'generated',item.generation_run_id,case when n<=5 then d end,case when n<=5 then n end);
     if n<=5 then update public.daily_questions set question=item.question where challenge_date=d and position=n; end if;
   end if;
 end loop;
 alter table public.daily_questions enable trigger daily_freeze_questions;
 update public.question_catalog c set retired_at=clock_timestamp() where retired_at is null and not exists(select 1 from public.qgen_rollout_stage s where s.catalog_id=c.id);
 update public.ranked_question_bank set retired_at=clock_timestamp() where retired_at is null;
 insert into public.ranked_question_bank(question,catalog_id,generation_run_id)
 select c.question,s.catalog_id,s.generation_run_id from public.qgen_rollout_stage s join public.question_catalog c on c.id=s.catalog_id order by s.id offset 25;
 if (select count(*) from public.daily_question_queue where consumed_date is null)<>20
 or (select count(*) from public.ranked_questions)<>106 then raise exception 'Unexpected final inventory'; end if;
end $$;
commit;
-- Staging artifacts are removed only after the atomic cutover committed successfully.
drop function public.qgen_rollout_commit(uuid,uuid,uuid,jsonb);
drop table public.qgen_rollout_stage;
notify pgrst,'reload schema';
