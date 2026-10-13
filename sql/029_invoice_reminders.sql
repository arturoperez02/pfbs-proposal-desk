-- =====================================================================
-- PFBS Proposal Desk — update 029: payment reminders
--   • invoices.reminders keeps which reminders were emailed (days from the due date + when + to whom),
--     so the Money tab shows only the reminders still due (schedule in Settings → Invoicing)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 028 first.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.import_hcp_paid_invoices(jsonb)') is null then
    raise exception 'Run updates 007 to 028 first, then run this one again.';
  end if;
end $$;

alter table public.invoices add column if not exists reminders jsonb not null default '[]'::jsonb;

notify pgrst, 'reload schema';
