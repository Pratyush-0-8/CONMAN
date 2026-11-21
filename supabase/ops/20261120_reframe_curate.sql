-- Rollout-only quality curation: preserve the earliest distinct client situation.
-- Removed staging entries remain in the catalog and generation audit; live pools are untouched.
with removed as (
 delete from public.qgen_rollout_stage s using public.question_catalog c
 where c.id=s.catalog_id and exists(
  select 1 from public.qgen_rollout_stage earlier join public.question_catalog old on old.id=earlier.catalog_id
  where earlier.id<s.id and public.qgen_near(split_part(c.question,'. ',1),split_part(old.question,'. ',1))
 ) returning s.id
) select count(*) as pruned_repeated_premises from removed;
