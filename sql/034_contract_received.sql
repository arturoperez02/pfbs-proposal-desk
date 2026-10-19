-- =====================================================================
-- PFBS Proposal Desk — update 034: Contract / PO received on approved jobs
--   • proposals.contract_on: the day the client's signed contract / PO came in (or the day it was marked
--     "approved by email, no contract"), proposals.contract_note: what came in ("Signed contract", "PO 4455", …)
--   • the job's steps start with Contract; scheduling before it's in asks first
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 033 first.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.job_for_hcp_no(text)') is null then
    raise exception 'Run updates 007 to 033 first, then run this one again.';
  end if;
end $$;

alter table public.proposals add column if not exists contract_on date;
alter table public.proposals add column if not exists contract_note text;

notify pgrst, 'reload schema';
