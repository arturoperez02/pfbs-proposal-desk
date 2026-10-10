-- PFBS Proposal Desk — update 005: renewal reminders, change orders, proposal revisions.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
alter table public.proposals
  add column if not exists renewal_date  date,                                   -- next renewal / service due (blank = suggested from frequency)
  add column if not exists renewal_of    text,                                   -- the proposal this one renews
  add column if not exists rev           int  not null default 1,                -- revision number (Rev 2, Rev 3…)
  add column if not exists revisions     jsonb not null default '[]'::jsonb,     -- history of earlier revisions
  add column if not exists change_orders jsonb not null default '[]'::jsonb;     -- change orders after approval
notify pgrst, 'reload schema';
