-- Remove only reviewed duplicate, vague, ordinary, or domain-dependent staging entries.
-- Catalog history and generation audits remain intact; live pools are untouched.
with removed as (delete from public.qgen_rollout_stage where id in (13,32,36,45,48,51,56,58,64,65,74,75,81,83,86,88,90,91,95,96,99,106,108,109,110,113,114,115,123,127,129,133,134,138,139,147,151,152,156,157,158,162,163,164,165,166,167,169,171,172,174,181,182,184,186,187,190,193,203,207,208,210) returning id) select count(*) as reviewed_removals from removed;
