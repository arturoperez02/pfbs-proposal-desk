-- =====================================================================
-- PFBS Proposal Desk — update 031: proposal numbers start at PFBS-0803
--   • the next new proposal gets PFBS-0803 (or the number after the highest one already used, if that is higher),
--     then 0804, 0805… Numbers already given are not changed.
--   • next_proposal_no / set_next_proposal_no: Settings → Proposal numbers shows and sets the next number
--     (owner or admin; it can never go back to a number already used)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 030 first.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.hcp_invoice_details(jsonb)') is null then
    raise exception 'Run updates 007 to 030 first, then run this one again.';
  end if;
end $$;

create sequence if not exists public.proposal_seq start 803;

create or replace function public.max_proposal_no() returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(max((regexp_match(num, '^PFBS-(\d+)$'))[1]::bigint), 0) from (
    select num from public.proposals union all select num from public.deleted_proposals) q
$$;

create or replace function public.next_proposal_no() returns bigint
language sql stable security definer set search_path = public as $$
  select case when is_called then last_value + 1 else last_value end from public.proposal_seq
$$;

create or replace function public.set_next_proposal_no(n bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare mx bigint := public.max_proposal_no();
begin
  if coalesce(public.my_role(),'') not in ('Owner','Admin') then raise exception 'Only the owner or admin can change proposal numbering.'; end if;
  if n is null or n <= mx then raise exception 'The next proposal # must be higher than % (the last one used).', mx; end if;
  perform setval('public.proposal_seq', n, false);
  insert into public.admin_log(by_name, area, item, new_value) values (public.my_name(), 'Settings', 'Next proposal #', n::text);
  return n;
end $$;
revoke execute on function public.max_proposal_no(), public.next_proposal_no(), public.set_next_proposal_no(bigint) from public, anon;
grant execute on function public.next_proposal_no(), public.set_next_proposal_no(bigint) to authenticated;

-- one time: the next new proposal is PFBS-0803, or after the highest number in use (never moves backward)
do $$ declare want bigint := greatest(803, public.max_proposal_no() + 1); begin
  if public.next_proposal_no() < want then perform setval('public.proposal_seq', want, false); end if;
end $$;

notify pgrst, 'reload schema';
