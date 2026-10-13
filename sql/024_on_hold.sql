-- =====================================================================
-- PFBS Proposal Desk — update 024: jobs on hold
--   • a job can be put on hold (paused by the client, waiting on access, weather…) with a reason,
--     and taken off hold later; it keeps its status, job # and schedule
--   • the Home tab and the Jobs board show held jobs in their own column
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 023 first.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.crm_job_numbers()') is null then
    raise exception 'Run updates 007 to 023 first, then run this one again.';
  end if;
end $$;

alter table public.proposals
  add column if not exists on_hold_since  date,
  add column if not exists on_hold_reason text;

notify pgrst, 'reload schema';
