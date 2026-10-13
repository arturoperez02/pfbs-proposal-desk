-- =====================================================================
-- PFBS Proposal Desk — update 023: the job # comes when the proposal is approved
--   • approving a proposal turns it into a job and gives it the next job # (once the CRM numbers jobs:
--     Settings → Job numbers); before that, the HCP job # typed at approval is the job #
--   • the job's first visit uses the job's #; later visits of a recurring job get their own # (like HCP)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 022 first.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.set_next_job_no(bigint)') is null then
    raise exception 'Run updates 007 to 022 first, then run this one again.';
  end if;
end $$;

create or replace function public.crm_job_numbers() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.private_settings where key = 'crm_job_numbers' and value = 'on')
$$;
grant execute on function public.crm_job_numbers() to authenticated;

create or replace function public.proposals_job_no() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('Approved','Scheduled','Invoiced','Paid') and coalesce(new.hcp_job,'') = '' and public.crm_job_numbers()
     and (tg_op = 'INSERT' or old.status is distinct from new.status or coalesce(old.hcp_job,'') <> '') then
    new.hcp_job := nextval('public.job_no_seq')::text;
  end if;
  return new;
end $$;
drop trigger if exists proposals_job_no on public.proposals;
create trigger proposals_job_no before insert or update of status, hcp_job on public.proposals for each row execute function public.proposals_job_no();

create or replace function public.visits_job_no() returns trigger
language plpgsql security definer set search_path = public as $$
declare jn text;
begin
  if new.kind = 'job' and coalesce(new.job_no,'') = '' then
    if new.num is not null then jn := nullif((select hcp_job from public.proposals where num = new.num), ''); end if;
    if jn is not null and not exists (select 1 from public.visits where num = new.num and job_no = jn and id <> new.id) then
      new.job_no := jn;                                        -- the job's own number
    elsif public.crm_job_numbers() then
      new.job_no := nextval('public.job_no_seq')::text;        -- another visit of the same job (recurring)
    else
      new.job_no := jn;
    end if;
  end if;
  return new;
end $$;

revoke execute on function public.proposals_job_no(), public.visits_job_no() from public, anon, authenticated;

notify pgrst, 'reload schema';
