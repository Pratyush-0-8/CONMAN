begin;
-- Keep original full-question similarity checks; allow distinct objects in otherwise related settings.
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
      if public.qgen_near(q,candidate) or public.qgen_normalize(split_part(q,'. ',1))=public.qgen_normalize(split_part(candidate,'. ',1)) then raise exception 'Duplicate or similar questions inside batch'; end if;
    end loop;
    if exists(select 1 from public.question_catalog c where c.normalized=norm_text
      or (c.tokens && content_tokens and (public.qgen_token_near(c.tokens,content_tokens) or public.qgen_normalize(split_part(q,'. ',1))=public.qgen_normalize(split_part(c.question,'. ',1))))) then raise exception 'Duplicate or near-duplicate historical question: %',left(q,150); end if;
    seen:=array_append(seen,q);
  end loop;
  if exists(select 1 from jsonb_array_elements(p_questions) x where jsonb_typeof(x)<>'string') then raise exception 'Questions must be strings'; end if;
end $$;
notify pgrst,'reload schema';
commit;
