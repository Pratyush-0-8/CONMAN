-- Add an exact strictly-below count; retain the existing aggregate/ownership contract.
begin;
create or replace function public.daily_distribution(p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
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
  return jsonb_build_object('date',a.challenge_date,'count',n,'below_count',below,'percentile',round(100*(below+ties/2.0)/greatest(n,1),1),'bins',bins);
end $$;
notify pgrst,'reload schema';
commit;
