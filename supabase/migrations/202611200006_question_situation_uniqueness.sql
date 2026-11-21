begin;
set local lock_timeout='5s';
-- Preserve full-question validation and reject reused situations with reworded objectives.
create or replace function public.qgen_validate(p_questions jsonb,p_count integer) returns void language plpgsql security definer set search_path='' as $$
declare q text; seen text[]:='{}'; candidate text; words integer; norm_text text; content_tokens text[];
begin
  if jsonb_typeof(p_questions) is distinct from 'array' or jsonb_array_length(p_questions)<>p_count then raise exception 'Incorrect question batch size'; end if;
  for q in select value#>>'{}' from jsonb_array_elements(p_questions) e(value) loop
    if q is null or length(q)>250 or q<>trim(regexp_replace(q,'[[:space:]]+',' ','g')) or right(q,1)<>'?' then raise exception 'Invalid question formatting'; end if;
    norm_text:=public.qgen_normalize(q); content_tokens:=public.qgen_tokens(q);
    words:=cardinality(string_to_array(norm_text,' '));
    if words<8 or words>35 then raise exception 'Questions must contain 8–35 words (target 12–25)'; end if;
    foreach candidate in array seen loop
      if public.qgen_near(q,candidate) or public.qgen_near(split_part(q,'. ',1),split_part(candidate,'. ',1)) then raise exception 'Duplicate or similar questions inside batch'; end if;
    end loop;
    if exists(select 1 from public.question_catalog c where c.normalized=norm_text
      or (c.tokens && content_tokens and (public.qgen_token_near(c.tokens,content_tokens) or public.qgen_near(split_part(q,'. ',1),split_part(c.question,'. ',1))))) then raise exception 'Duplicate or near-duplicate historical question: %',left(q,150); end if;
    seen:=array_append(seen,q);
  end loop;
  if exists(select 1 from jsonb_array_elements(p_questions) x where jsonb_typeof(x)<>'string') then raise exception 'Questions must be strings'; end if;
end $$;
-- A bounded situation exclusion list supplies the context needed to avoid conceptual repeats.
create or replace function public.qgen_context() returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('daily_unused',(select count(*) from public.daily_question_queue where consumed_date is null),
    'arena_active',(select count(*) from public.ranked_questions),'daily_request_limit',s.daily_request_limit,
    'requests_today',(select count(*) from public.question_generation_requests where started_at>=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'),
    'quota_exhausted_on',s.quota_exhausted_on,'cooldown_until',s.cooldown_until,
    'history',(select coalesce(jsonb_agg(question),'[]') from (
      (select question from public.question_catalog order by id desc limit 100)
      union (select question from public.daily_questions order by challenge_date desc,position limit 10)
      union (select question from public.ranked_questions order by id limit 10)
    ) q)) from public.question_generation_settings s where singleton;
$$;
notify pgrst,'reload schema';
commit;
