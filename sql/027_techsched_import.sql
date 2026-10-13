-- =====================================================================
-- PFBS Proposal Desk — update 027: bring TechSched's upcoming jobs into the CRM schedule
--   • visits.ext_id remembers where an imported visit came from ("techsched:<id>"), so the import
--     (Schedule → Import from TechSched) can run again to pick up new or changed jobs without duplicates
--   • TechSched itself is only read, never changed
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 026 first.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.can_warehouse()') is null then
    raise exception 'Run updates 007 to 026 first, then run this one again.';
  end if;
end $$;

alter table public.visits add column if not exists ext_id text;
create unique index if not exists visits_ext_id_idx on public.visits(ext_id) where ext_id is not null;

notify pgrst, 'reload schema';
