begin;
set local lock_timeout='5s';
alter table public.question_catalog add column retired_at timestamptz;
create or replace function public.qgen_context() returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('daily_unused',(select count(*) from public.daily_question_queue where consumed_date is null),
    'arena_active',(select count(*) from public.ranked_questions),'daily_request_limit',s.daily_request_limit,
    'requests_today',(select count(*) from public.question_generation_requests where started_at>=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'),
    'quota_exhausted_on',s.quota_exhausted_on,'cooldown_until',s.cooldown_until,
    'history',(select coalesce(jsonb_agg(question),'[]') from (
      (select question from public.question_catalog where retired_at is null order by id desc limit 100)
      union (select question from public.daily_questions order by challenge_date desc,position limit 10)
      union (select question from public.ranked_questions order by id limit 10)
    ) q)) from public.question_generation_settings s where singleton;
$$;
notify pgrst,'reload schema';
commit;
