-- PFBS Proposal Desk — update 004: job actuals (visits logged after the work is done).
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
alter table public.proposals add column if not exists actuals jsonb not null default '[]'::jsonb;
notify pgrst, 'reload schema';
