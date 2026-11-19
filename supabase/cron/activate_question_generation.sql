-- MANUAL OPT-IN ONLY. This file is NOT a migration and is never run by deployment.
-- Enable pg_cron, pg_net, and Vault through the Supabase dashboard first.
-- Create Vault secrets through the dashboard (no values belong in this file):
--   conman_project_url = https://YOUR_PROJECT_REF.supabase.co
--   conman_question_generation_secret = same strong value as Edge QUESTION_GENERATION_SECRET
-- To permit creation of the helper below, deliberately run this first in the SQL editor:
--   set conman.allow_question_cron_setup = 'yes';
-- All created Cron jobs are immediately INACTIVE. Activate each one separately after testing.

do $$ begin
  if current_setting('conman.allow_question_cron_setup',true) is distinct from 'yes' then
    raise exception 'Cron setup has not been explicitly authorized in this SQL session';
  end if;
  if not exists(select 1 from pg_extension where extname='pg_cron') or not exists(select 1 from pg_extension where extname='pg_net') then
    raise exception 'Enable pg_cron and pg_net before setting up these jobs';
  end if;
  if not exists(select 1 from vault.decrypted_secrets where name='conman_project_url')
     or not exists(select 1 from vault.decrypted_secrets where name='conman_question_generation_secret') then raise exception 'Configure both Vault secrets first'; end if;
end $$;

create or replace function public.qgen_cron_invoke(p_action text) returns bigint language plpgsql security definer set search_path='' as $$
declare project_url text; invocation_secret text; request_id bigint;
begin
  if p_action not in ('daily_refill','daily_publish','arena_rotate') then raise exception 'Invalid scheduled job'; end if;
  select decrypted_secret into strict project_url from vault.decrypted_secrets where name='conman_project_url';
  select decrypted_secret into strict invocation_secret from vault.decrypted_secrets where name='conman_question_generation_secret';
  select net.http_post(url:=rtrim(project_url,'/')||'/functions/v1/generate-questions',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||invocation_secret),
    body:=jsonb_build_object('action',p_action),timeout_milliseconds:=120000) into request_id;
  return request_id;
end $$;
revoke all on function public.qgen_cron_invoke(text) from public,anon,authenticated;

-- Register inactive jobs atomically. No schedules become active just by pasting this file.
begin;
do $$ declare job_id bigint; begin
  if exists(select 1 from cron.job where jobname in ('conman-daily-refill','conman-daily-publish','conman-arena-rotate')) then
    raise exception 'Jobs already exist; inspect/alter them instead of creating duplicates';
  end if;
  job_id:=cron.schedule('conman-daily-refill','*/5 * * * *',$job$select public.qgen_cron_invoke('daily_refill');$job$);
  perform cron.alter_job(job_id,active:=false);
  job_id:=cron.schedule('conman-daily-publish','*/5 * * * *',$job$select public.qgen_cron_invoke('daily_publish');$job$);
  perform cron.alter_job(job_id,active:=false);
  job_id:=cron.schedule('conman-arena-rotate','*/30 * * * *',$job$select public.qgen_cron_invoke('arena_rotate');$job$);
  perform cron.alter_job(job_id,active:=false);
end $$;
commit;

-- After dry-run/manual testing, enable each application job AND its Cron schedule explicitly:
-- update public.question_generation_jobs set enabled=true where job='daily_refill';
-- select cron.alter_job((select jobid from cron.job where jobname='conman-daily-refill'),active:=true);
-- Repeat with daily_publish/conman-daily-publish or arena_rotate/conman-arena-rotate.
-- Pause independently using active:=false and/or enabled=false.
