-- =====================================================================
-- PFBS Proposal Desk — update 033: open HousecallPro invoices find their CRM job by job #
--   • an open (not paid, not void) invoice imported from HousecallPro links to the CRM job whose job # matches
--     (the job's own # or one of its visits' #s) — now, and whenever that job # shows up later
--   • so recording the payment in Money marks the job Paid with the payment date (commission starts),
--     without the "Invoiced in HousecallPro" card
--   • paid history from HousecallPro (update 028) is never linked: it never changes a job
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 032 first.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.pfbs_materials(jsonb,text)') is null then
    raise exception 'Run updates 007 to 032 first, then run this one again.';
  end if;
end $$;

-- the CRM job for a HousecallPro job #: the job's own #, else a visit with that #
create or replace function public.job_for_hcp_no(jn text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select num from public.proposals where hcp_job = jn order by num desc limit 1),
    (select num from public.visits where job_no = jn and num is not null order by visit_date desc limit 1))
$$;

-- an open HCP invoice without a job picks it up on any change (e.g. when a payment is recorded), before the paid logic runs
create or replace function public.invoices_hcp_link() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'hcp' and new.num is null and coalesce(new.job_no,'') <> '' and new.status in ('Draft','Sent')
     and (tg_op = 'INSERT' or old.status in ('Draft','Sent')) then
    new.num := public.job_for_hcp_no(new.job_no);
  end if;
  return new;
end $$;
drop trigger if exists invoices_hcp_link on public.invoices;
create trigger invoices_hcp_link before insert or update on public.invoices for each row execute function public.invoices_hcp_link();

-- a job # given later (on the job or a visit) links the open HCP invoices that carry it
create or replace function public.link_hcp_invoices_to(jn text, pnum text) returns void
language sql security definer set search_path = public as $$
  update public.invoices set num = pnum
   where source = 'hcp' and num is null and job_no = jn and status in ('Draft','Sent') and coalesce(jn,'') <> '' and pnum is not null
$$;
create or replace function public.proposals_hcp_link() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.hcp_job,'') <> '' and (tg_op = 'INSERT' or coalesce(old.hcp_job,'') <> new.hcp_job) then perform public.link_hcp_invoices_to(new.hcp_job, new.num); end if;
  return null;
end $$;
drop trigger if exists proposals_hcp_link on public.proposals;
create trigger proposals_hcp_link after insert or update of hcp_job on public.proposals for each row execute function public.proposals_hcp_link();
create or replace function public.visits_hcp_link() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.job_no,'') <> '' and new.num is not null and (tg_op = 'INSERT' or coalesce(old.job_no,'') <> new.job_no or old.num is distinct from new.num) then perform public.link_hcp_invoices_to(new.job_no, new.num); end if;
  return null;
end $$;
drop trigger if exists visits_hcp_link on public.visits;
create trigger visits_hcp_link after insert or update of job_no, num on public.visits for each row execute function public.visits_hcp_link();

-- link the ones already imported
update public.invoices i set num = public.job_for_hcp_no(i.job_no)
 where i.source = 'hcp' and i.num is null and coalesce(i.job_no,'') <> '' and i.status in ('Draft','Sent') and public.job_for_hcp_no(i.job_no) is not null;

revoke execute on function public.job_for_hcp_no(text), public.invoices_hcp_link(), public.link_hcp_invoices_to(text,text), public.proposals_hcp_link(), public.visits_hcp_link() from public, anon, authenticated;

notify pgrst, 'reload schema';
