-- PFBS Proposal Desk — update 002: multiple services, add-ons, client details, PDF.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
alter table public.proposals
  add column if not exists items          jsonb not null default '[]'::jsonb,  -- line items: services, options, add-ons
  add column if not exists pricing_option text,                               -- which option the totals use
  add column if not exists contact_name   text,
  add column if not exists bill_address   text,
  add column if not exists contact_email  text,
  add column if not exists contact_phone  text,
  add column if not exists site_address   text,
  add column if not exists clarifications text;
notify pgrst, 'reload schema';
