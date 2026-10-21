-- =====================================================================
-- PFBS Proposal Desk — update 039: more than one contact per building, and third-party management companies
--   • properties.cc_contact_ids: besides the building's main contact (contact_id), the people copied (CC) on
--     proposals, follow-ups and service reports for that building. Invoices still go to the client's billing (AP) email.
--   • clients.managed_by: an owner client ("601 12th Street Owner LLC (C&W)") managed by another client record
--     (Cushman & Wakefield). The manager's contacts are typed once and can be picked on the owner's buildings.
--   • clients.kind can be 'Management company'.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 038 first.
-- =====================================================================
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'proposals' and column_name = 'client_requests') then
    raise exception 'Run updates 007 to 038 first, then run this one again.';
  end if;
end $$;

alter table public.properties add column if not exists cc_contact_ids uuid[] not null default '{}';
alter table public.clients add column if not exists managed_by uuid references public.clients(id) on delete set null;
alter table public.clients drop constraint if exists clients_kind_check;
alter table public.clients add constraint clients_kind_check check (kind in ('Business', 'Homeowner', 'Management company'));
alter table public.clients drop constraint if exists clients_not_own_manager;
alter table public.clients add constraint clients_not_own_manager check (managed_by is null or managed_by <> id);

notify pgrst, 'reload schema';
