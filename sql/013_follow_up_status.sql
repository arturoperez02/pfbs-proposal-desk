-- =====================================================================
-- PFBS Proposal Desk — update 013: one "Sent" status
--   Follow-ups are tracked automatically (day 3, 10, 21, then every 14 days),
--   so the separate "Follow-up" status is retired. Proposals marked Follow-up
--   become Sent; their follow-up history stays in each proposal's Activity.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- =====================================================================
select set_config('pfbs.actor', 'Update 013', true);
update public.proposals set status = 'Sent' where status = 'Follow-up';
