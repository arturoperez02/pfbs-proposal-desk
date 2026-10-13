-- =====================================================================
-- PFBS Proposal Desk — update 024: jobs on hold
--   • a job can be put on hold (paused by the client, waiting on access, weather…) with a reason,
--     and taken off hold later; it keeps its status, job # and schedule
--   • the Home tab and the Jobs board show held jobs in their own column
--   • assign_job_no: gives an approved job with no job # the next CRM job # (the "Give it a job #" button),
--     for jobs approved before the CRM started numbering
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

create or replace function public.assign_job_no(p_num text) returns text
language plpgsql security definer set search_path = public as $$
declare jn text; v record; first boolean := true;
begin
  if not public.is_manager() then raise exception 'Only managers can give a job its number.'; end if;
  if not public.crm_job_numbers() then raise exception 'Turn on CRM job numbers first (Settings → Job numbers).'; end if;
  select hcp_job into jn from public.proposals where num = p_num and status in ('Approved','Scheduled','Invoiced','Paid');
  if not found then raise exception 'Approve the proposal first.'; end if;
  if coalesce(jn,'') <> '' then return jn; end if;
  jn := nextval('public.job_no_seq')::text;
  update public.proposals set hcp_job = jn where num = p_num;
  for v in select id from public.visits where num = p_num and kind = 'job' and coalesce(job_no,'') = '' order by visit_date loop
    update public.visits set job_no = case when first then jn else nextval('public.job_no_seq')::text end where id = v.id;
    first := false;
  end loop;
  insert into public.proposal_activity(num, by_name, kind, note) values (p_num, coalesce(nullif(public.my_name(),''),'Office'), 'note', 'Job #' || jn || ' given');
  return jn;
end $$;
revoke execute on function public.assign_job_no(text) from public, anon, authenticated;
grant execute on function public.assign_job_no(text) to authenticated;

notify pgrst, 'reload schema';
