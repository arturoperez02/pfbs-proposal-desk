-- =====================================================================
-- PFBS Proposal Desk — update 041: the client work schedule (Arturo 10/26)
--   • proposals.client_schedule: what gets done each work day ("Day 1 – A11 & A12 (roof)") and the notes for the client,
--     in the order of the job's work days: {rows:[{work, note, red}], sent:[{at, by, to, rev}]}. The dates come from the
--     job's schedule and the "actual date completed" from the saved hours / Done visits, so they are never typed here.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 040 first.
-- =====================================================================
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'visits' and column_name = 'supervisor') then
    raise exception 'Run updates 007 to 040 first, then run this one again.';
  end if;
end $$;

alter table public.proposals add column if not exists client_schedule jsonb;

notify pgrst, 'reload schema';
